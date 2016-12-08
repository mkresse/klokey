"use strict";

var nconf = require('nconf');
var express = require('express');
var bodyParser = require('body-parser');
var session = require('cookie-session');
var http = require('http');
var https = require('https');
var fs = require('fs');
var socket = require('socket.io');
var shortid = require('shortid');
var _ = require('underscore');
var Chromath = require('chromath');
var path = require('path');
var moment = require('moment');
var nodemailer = require('nodemailer');
var EmailTemplate = require('email-templates').EmailTemplate;

var sensorModule = require('./sensor.js');
var display = require('./display.js');
var anim = require('./anim.js');
var hipchat = require('./hipchat.js');

var vars = {
    SESSION_NAME: 'kk_sess',
    SESSION_KEY: 'secr3t',
    CLEANUP_DELAY: 3000,
    MISSING_TIMEOUT: 5000,
    MISSING_MAIL_TIMEOUT: 3000,
    RFID_WATCHDOG_TIMEOUT: 3500,
    QUEUE_TIMEOUT: 10000,
    ANIM_TIME: 200
};

moment.locale('de');
nconf.argv().env().file({ file: 'config.json' });

var serverOptions = {
    key: fs.readFileSync(nconf.get('privateKey')),
    cert: fs.readFileSync(nconf.get('certificate'))
};

var transporter = nodemailer.createTransport(nconf.get('mail').transport);
var templateDir = path.join(__dirname, 'templates', 'missing');
var sendMissingMail = transporter.templateSender(new EmailTemplate(templateDir),
    {
        "from": nconf.get('mail').from,
        "to": nconf.get('mail').to
    }
);

display.init();
anim.init({interval: 10});
var sensor = sensorModule.init(vars);

sensor.on('error', function() {
    process.exit(1);
});

sensor.on('open', function() {
    console.log('Current gid: ' + process.getgid());
    console.log('Current uid: ' + process.getuid());

    var gid = parseInt(process.env.SUDO_GID);
    if (gid) {
        process.setgid(gid);
        console.log('Switched to gid: ' + process.getgid());
    }

    var uid = parseInt(process.env.SUDO_UID);
    if (uid) {
        process.setuid(uid);
        console.log('Switched to uid: ' + process.getuid());
    }
});


var app = express();
var server = https.createServer(serverOptions, app);
var io = socket(server);

var messages = {
    HELLO: 'HELLO',

    REQ_ENQUEUE: 'REQ_ENQUEUE',
    REQ_LEAVE_QUEUE: 'REQ_LEAVE_QUEUE',

    EV_KEY_TAKEN: 'EV_KEY_TAKEN',
    EV_KEY_RETURNED: 'EV_KEY_RETURNED',
    EV_KEY_WENT_MISSING: 'EV_KEY_WENT_MISSING',
    EV_RESERVATION_QUEUED: 'EV_RESERVATION_QUEUED',
    EV_RESERVATION_REMOVED: 'EV_RESERVATION_REMOVED'
};

var state = {
    keyPresent: false,
    keyMissing: false,
    keyTakenOn: undefined,
    queue: []
};

var internalState = {
    timerMissing: undefined,
    timerQueue: undefined,
    clientConnectionsMap: {}
};

var sessionMiddleware = session({
    secret: vars.SESSION_KEY,
    name: vars.SESSION_NAME
});

// enable parsing of application/json
app.use(bodyParser.json());

// enable CORS
app.use(function(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

// execute session middleware for http traffic
app.use(sessionMiddleware,
    function (req, res, next) {
        console.log('request: %s %d: %s', req.session.clientId, Date.now(), req.originalUrl);
        if (!req.session.clientId || (""+req.session.clientId).length < 2) {
            req.session.clientId = shortid.generate();
            console.log('Generated clientId: ', req.session.clientId);
        }

        next();
    }
);

// execute session middleware for socket traffic
io.use(function(socket, next) {
    sessionMiddleware(socket.request, socket.request.res, next);
});

app.use(express.static('web'));
app.use('/lib', express.static('lib'));

app.get('/state', function (req, res) {
    res.json(state);
});

app.get('/test', function (req, res) {
    res.sendFile(__dirname + '/web/test.html');
});

app.get('/switch', function (req, res) {
    if (state.keyPresent) {
        onKeyTaken();
    } else {
        onKeyReturned();
    }

    res.json(state);
});

var hipchatIntegration = hipchat.init(app, nconf.get('hipchat'), state);

function addToQueue(clientId) {
    if (!_.findWhere(state.queue, {clientId: clientId})) {
        state.queue.push({clientId: clientId});
        updateQueueTimer();
        io.emit('message', {type: messages.EV_RESERVATION_QUEUED, state: state});
        return true;
    }

    return false;
}

function removeFromQueue(clientId) {
    state.queue = _.reject(state.queue, function(entry) {
        return entry.clientId === clientId;
    });
    updateQueueTimer();
    io.emit('message', {type: messages.EV_RESERVATION_REMOVED, state: state});
}

function updateQueueTimer() {
    if (internalState.timerQueue && (!state.keyPresent || state.queue.length < 1 || !state.queue[0].expires)) {
        // delete obsolete timer
        clearTimeout(internalState.timerQueue);
        internalState.timerQueue = undefined;
    }

    for (var i=0; i<state.queue.length; i++) {
        var entry = state.queue[i];
        if (state.keyPresent && (i === 0)) {
            if (!entry.expires) {
                var clientId = entry.clientId;
                internalState.timerQueue = setTimeout(function() {
                    onQueueTimerExpired(clientId);
                }, vars.QUEUE_TIMEOUT);
                entry.expires = Date.now() + vars.QUEUE_TIMEOUT;
                queueTimerAnimation();
            }
        } else {
            entry.expires = undefined;
        }
    }

    updateDisplayState();
}

function p2l(phase) {
    return 2 << (((phase + 5) % 6));
}

function queueTimerAnimation() {
    var phase = 0;
    var phaseTime = vars.QUEUE_TIMEOUT / 6;
    var color = Chromath.yellow.darken(0.4);

    var doTicks = true;
    var ticks = 0;
    var tick = function() {
        if (internalState.timerQueue) {
            anim.addAmination(anim.CENTER, Chromath.rgba(0,0,0,0), ++ticks%2 ? Chromath.orange.darken(0.2) : Chromath.black, vars.ANIM_TIME, null, 1);
            if (doTicks || ticks%2) {
                setTimeout(tick, 500);
            }
        }
    };

    var nextPhase = function() {
        if (internalState.timerQueue && (phase < 7)) {
            anim.addAmination(p2l(phase), color, Chromath.black, phaseTime, null, 1);
            phase++;
            if (phase < 6) {
                setTimeout(nextPhase, phaseTime);
            }
        }
    };

    anim.addAmination(anim.RING, Chromath.rgba(0,0,0,0), color, vars.ANIM_TIME, null, 1);
    tick();
    nextPhase();

    setTimeout(function() {
        doTicks = false;
    }, vars.QUEUE_TIMEOUT - 1000);

    // test abort
    /*setTimeout(function() {
        phase = 9;
        doTicks = false;
        anim.clearQueue();
        anim.addAmination(RING, transp, Chromath.red, 200, null, 1);
        anim.addAmination(CENTER, transp, Chromath.black, 200, null, 1);
    }, 6000);
*/
}
//anim.addAmination(RING, transp, Chromath.green, 200, null, 1);
//setTimeout(function() {
//    timer();
//}, 1000);

function updateDisplayState() {

    if (state.keyMissing) {
        anim.clearQueue();
        anim.addAmination(anim.CENTER, Chromath.rgba(0,0,0,0), Chromath.black, vars.ANIM_TIME, null, 1);
        anim.addAmination(anim.RING,   Chromath.rgba(0,0,0,0), Chromath.red, vars.ANIM_TIME, null, 1);
    } else {
        if (state.keyPresent) {
            if (state.queue.length === 0) {
                anim.clearQueue();
                anim.addAmination(anim.CENTER, Chromath.rgba(0,0,0,0), Chromath.black, vars.ANIM_TIME, null, 1);
                anim.addAmination(anim.RING,   Chromath.rgba(0,0,0,0), Chromath.green, vars.ANIM_TIME, null, 1);
            } else {
                //queueTimerAnimation();
            }
        } else {
            anim.clearQueue();
            anim.addAmination(anim.CENTER, Chromath.rgba(0,0,0,0), Chromath.black, vars.ANIM_TIME, null, 1);
            anim.addAmination(anim.RING,   Chromath.rgba(0,0,0,0), Chromath.orange, vars.ANIM_TIME, null, 1);
        }
    }
}

sensor.on('RFIDWatchdogExpired', function() {
    console.log('RFID timer expired, assuming key taken');

    onKeyTaken();
});

sensor.on('RFIDDataReceived', function() {
    if (!state.keyPresent) {
        onKeyReturned();
    }
});

function onQueueTimerExpired(clientId) {
    console.log('timer expired for client: ', clientId);

    internalState.timerQueue = undefined;
    removeFromQueue(clientId);
}

function onKeyTaken() {
    if (!state.keyPresent) {
        console.warn('illegal state - ignoring taken event');
    } else {
        console.log('key was TAKEN');

        state.keyPresent = false;
        state.keyTakenOn = new Date();
        internalState.timerMissing = setTimeout(function() {
            onKeyWentMissing();
        }, vars.MISSING_TIMEOUT);

        if (state.queue.length > 0) {
            removeFromQueue(state.queue[0].clientId);
        }

        updateDisplayState();
        io.emit('message', {type: messages.EV_KEY_TAKEN, state: state});
        hipchatIntegration.notifyKeyTaken();
    }
}

function onKeyWentMissing() {
    console.log('key went MISSING');

    state.keyMissing = true;
    internalState.timerMissing = setTimeout(function() {
        onKeyMissingMail();
    }, vars.MISSING_MAIL_TIMEOUT);

    updateDisplayState();
    io.emit('message', {type: messages.EV_KEY_WENT_MISSING, state: state});
    hipchatIntegration.notifyKeyMissing();
}

function onKeyMissingMail() {
    console.log('sending missing email');

    internalState.timerMissing = undefined;

    // send mail to EVERYONE!
    var diff = moment.duration(moment(state.keyTakenOn).diff(moment())).humanize();
    //sendMissingMail({}, {"missing_since": diff});
}

function onKeyReturned() {
    if (state.keyPresent) {
        console.warn('illegal state - ignoring returned event');
    } else {
        console.log('key was RETURNED');

        state.keyPresent = true;
        state.keyMissing = false;
        state.keyTakenOn = undefined;
        if (internalState.timerMissing) {
            clearTimeout(internalState.timerMissing);
        }

        updateQueueTimer();

        updateDisplayState();
        io.emit('message', {type: messages.EV_KEY_RETURNED, state: state});
        hipchatIntegration.notifyKeyReturned();
    }
}

function onEnqueueRequest(clientId, replyFn) {
    console.log('enqueue requested from %s', clientId);
    if (addToQueue(clientId)) {
        replyFn('DONE!' + clientId);
    } else {
        replyFn('FAIL! mayby already enqueued, client ' + clientId);
    }
}

function onLeaveQueueRequest(clientId, replyFn) {
    console.log('leave queue requested from %s', clientId);
    removeFromQueue(clientId);
    replyFn('DONE! ' + clientId);
}

function getConnectionList(clientId) {
    var connections = internalState.clientConnectionsMap[clientId];
    if (_.isUndefined(connections)) {
        return (internalState.clientConnectionsMap[clientId] = []);
    }
    return connections;
}

function removeFromConnectionList(clientId, socketId) {
    var connections = getConnectionList(clientId);
    for (var i = connections.length-1; i >= 0 ; i--) {
        if (connections[i] === socketId){
            connections.splice(i, 1);
        }
    }

    if (connections.length === 0) {
        delete internalState.clientConnectionsMap[clientId];
        return true;
    }

    return false;
}

io.on('connection', function (socket) {
    var clientId = socket.request.session.clientId;
    getConnectionList(clientId).push(socket.id);

    console.log('a client connected from %s (%s)', socket.client.conn.remoteAddress, socket.id);

    console.log('connect headers', socket.request.headers);

    socket.send({type: messages.HELLO, state: state, clientId: clientId});

    socket.on('message', function (msg, replyFn) {
        clientId = socket.request.session.clientId;

        console.log('received message (%s): ', socket.id, msg);
        console.log('message headers', socket.request.headers);

        switch(msg.type) {
            case messages.REQ_ENQUEUE:
                onEnqueueRequest(clientId, replyFn);
                break;

            case messages.REQ_LEAVE_QUEUE:
                onLeaveQueueRequest(clientId, replyFn);
                break;
        }
    });

    socket.on('close', function() {
        console.log('a client closed (%s)', socket.id);
    });

    socket.on('disconnect', function() {
        console.log('a client disconnected (%s)', socket.id);
        // delay cleaning up to support browser reload
        setTimeout(function() {
            if (removeFromConnectionList(clientId, socket.id)) {
                console.log('last connection for client - cleaning up');
                removeFromQueue(clientId);
            }
        }, vars.CLEANUP_DELAY);
    });
});

server.listen(nconf.get('port'), function () {
    var addr = server.address();
    console.log("listening on %s:%d", addr.address, addr.port);
});
