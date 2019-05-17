"use strict";

var EventEmitter =  require('events').EventEmitter;
var nconf = require('nconf');
var winston = require('winston');
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
var url = require('url');
var anim = require('./anim.js');
var hipchat = require('./hipchat.js');
var publisher = require('./publish.js');

nconf.argv().env().file({ file: 'config.json' });

var sensorModule = nconf.get('enableSensor') ? require('./sensor.js') : {init:function() {return new EventEmitter()}};
var display = nconf.get('enableDisplay') ? require('./display.js') : {init:function(){}};

var logger = new (winston.Logger)({
    transports: [
        new (winston.transports.Console)({'timestamp':true, level: 'info' }),
        new (winston.transports.File)({'timestamp':true, filename: 'server.log', level: 'debug', json: false })
    ]
});

logger.info('starting KloKey server');

var vars = {
    SESSION_NAME: 'kk_sess',
    SESSION_KEY: 'secr3t',
    CLEANUP_DELAY: 3000,
    MISSING_TIMEOUT: 15 * 60 * 1000,
    MISSING_MAIL_TIMEOUT: 2 * 60 * 1000,
    RFID_WATCHDOG_TIMEOUT: 3500,
    QUEUE_TIMEOUT: 30000,
    ANIM_TIME: 250
};

moment.locale('de');

var transporter = nodemailer.createTransport(nconf.get('mail').transport);
var templateDir = path.join(__dirname, 'templates', 'missing');
var sendMissingMail = transporter.templateSender(new EmailTemplate(templateDir),
    {
        "from": nconf.get('mail').from,
        "to": nconf.get('mail').to
    }
);

publisher.init(nconf.get('mqtt'), logger);
publisher.publish('STARTED', '/server');

display.init(logger);
anim.init({interval: 10});
var sensor = sensorModule.init(vars, logger);

sensor.on('error', function() {
    process.exit(1);
});

sensor.on('open', function() {
    logger.info('Current gid: ' + process.getgid());
    logger.info('Current uid: ' + process.getuid());

    var gid = parseInt(process.env.SUDO_GID);
    if (gid) {
        process.setgid(gid);
        logger.info('Switched to gid: ' + process.getgid());
    }

    var uid = parseInt(process.env.SUDO_UID);
    if (uid) {
        process.setuid(uid);
        logger.info('Switched to uid: ' + process.getuid());
    }
});

var app = express();
var server = initServer(nconf);
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
    queue: []
};

if (nconf.get('debugMode')) {
    state.debugMode = true;

    vars.MISSING_TIMEOUT = 5000;
    vars.MISSING_MAIL_TIMEOUT = 3000;
    vars.QUEUE_TIMEOUT = 10000;

    logger.warn('Debug mode enabled: ignoring sensor, omitting email!');
}

var internalState = {
    keyTakenOn: undefined,
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
        logger.debug('request: %s %d: %s', req.session.clientId, Date.now(), req.originalUrl);
        if (!req.session.clientId || (""+req.session.clientId).length < 2) {
            req.session.clientId = shortid.generate();
            logger.debug('Generated clientId: ', req.session.clientId);
        }

        next();
    }
);

// execute session middleware for socket traffic
io.use(function(socket, next) {
    sessionMiddleware(socket.request, socket.request.res, next);
});

app.use(express.static('web'));
app.use('/lib', express.static('lib', {
    maxage: 3600*1000
}));

app.get('/state', function (req, res) {
    publisher.publish('STATE', '/server');
    res.json(state);
});

app.get('/test', function (req, res) {
    publisher.publish('TEST', '/server');
    res.sendFile(__dirname + '/web/test.html');
});

app.get('/switch', function (req, res) {
    publisher.publish('SWITCH', '/server');
    if (state.keyPresent) {
        onKeyTaken();
    } else {
        onKeyReturned();
    }

    res.json(state);
});

var hipchatIntegration = hipchat.init(app, nconf.get('hipchat'), state, logger);

function calcQueueRemainingTime() {
    if (state.queue.length > 0) {
        if (state.queue[0].expires) {
            state.queue[0].expiresIn = state.queue[0].expires - Date.now();
        } else {
            state.queue[0].expiresIn = undefined;
        }
    }
}

function addToQueue(clientId) {
    if (!_.findWhere(state.queue, {clientId: clientId})) {
        state.queue.push({clientId: clientId});
        updateQueueTimer();
        calcQueueRemainingTime();
        io.emit('message', {type: messages.EV_RESERVATION_QUEUED, state: state});
        publisher.publish(JSON.stringify(state), '/state', true);
        hipchatIntegration.notifyReservationQueued();
        return true;
    }

    return false;
}

function removeFromQueue(clientId, success) {
    var oldLength = state.queue.length;
    state.queue = _.reject(state.queue, function(entry) {
        return entry.clientId === clientId;
    });

    if (state.queue.length !== oldLength) {
        updateQueueTimer();
        calcQueueRemainingTime();
        io.emit('message', {type: messages.EV_RESERVATION_REMOVED, state: state, success: success || false});
        publisher.publish(JSON.stringify(state), '/state', true);
        hipchatIntegration.notifyReservationRemoved();
    }
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
                entry.expiryTime = vars.QUEUE_TIMEOUT;
                entry.expires = Date.now() + vars.QUEUE_TIMEOUT;
                queueTimerAnimation();
            }
        } else {
            entry.expiryTime = undefined;
            entry.expires = undefined;
        }
    }

    updateDisplayState();
}

function p2l(phase) {
    return 2 << (phase % 6);
}

function queueTimerAnimation() {
    var phase = 0;
    var phaseTime = vars.QUEUE_TIMEOUT / 6;
    var color = Chromath.rgb(0, 0.1, 0.7);

    var startedForTimer = internalState.timerQueue;

    var doTicks = true;
    var ticks = 0;
    var tick = function() {
        if (internalState.timerQueue === startedForTimer) {
            anim.addAmination(anim.CENTER, Chromath.rgba(0,0,0,0), ++ticks%2 ? Chromath.orange.darken(0.2) : Chromath.black, vars.ANIM_TIME, null, 1);
            if (doTicks || ticks%2) {
                setTimeout(tick, 500);
            }
        }
    };

    var nextPhase = function() {
        if (internalState.timerQueue === startedForTimer && (phase < 7)) {
            anim.addAmination(p2l(phase), color, Chromath.black, phaseTime, null, 1);
            phase++;
            if (phase < 6) {
                setTimeout(nextPhase, phaseTime);
            }
        }
    };

    anim.clearQueue();
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


var missingAnimTimer;

function missingStateAnimation() {
    var red_low = Chromath.rgb(0.6, 0, 0, 1);
    var red_high = Chromath.rgb(0.9, 0, 0, 1);
    var gamma = 1;

    var red_up = function() {
        anim.addAmination(anim.RING, Chromath.rgba(0,0,0,0), red_high, 1000, red_down, gamma);
    };

    var red_down = function() {
        anim.addAmination(anim.RING, red_low, red_high, 1000, null, -gamma);
    };

    anim.clearQueue();
    anim.addAmination(anim.RING, Chromath.rgba(0,0,0,0), red_low, vars.ANIM_TIME, null, 1);

    var startedTimer = (missingAnimTimer = setInterval(function() {
        if (startedTimer === missingAnimTimer) {
            red_up();
        } else {
            clearInterval(startedTimer);
        }
    }, 4000));
}

function updateDisplayState() {

    if (state.keyMissing) {
        missingStateAnimation();
    } else {
        missingAnimTimer = undefined;

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
    if (!state.debugMode) {
        logger.info('RFID timer expired, assuming key taken');

        onKeyTaken();
    }
});

sensor.on('RFIDDataReceived', function() {
    if (!state.keyPresent && !state.debugMode) {
        onKeyReturned();
    }
});

function onQueueTimerExpired(clientId) {
    logger.info('timer expired for client: ', clientId);
    publisher.publish('EXPIRED', '/queue');

    internalState.timerQueue = undefined;
    removeFromQueue(clientId);
}

function onKeyTaken() {
    if (!state.keyPresent) {
        logger.warn('illegal state - ignoring taken event');
    } else {
        logger.info('key was TAKEN');
        publisher.publish('TAKEN', '/event');

        state.keyPresent = false;
        internalState.keyTakenOn = new Date();
        internalState.timerMissing = setTimeout(function() {
            onKeyWentMissing();
        }, vars.MISSING_TIMEOUT);

        if (state.queue.length > 0) {
            removeFromQueue(state.queue[0].clientId, true);
        }

        updateDisplayState();
        calcQueueRemainingTime();
        io.emit('message', {type: messages.EV_KEY_TAKEN, state: state});
        publisher.publish(JSON.stringify(state), '/state', true);
        hipchatIntegration.notifyKeyTaken();
    }
}

function onKeyWentMissing() {
    logger.info('key went MISSING');
    publisher.publish('MISSING', '/event');

    state.keyMissing = true;
    state.keyMissingSince = new Date();
    internalState.timerMissing = setTimeout(function() {
        onKeyMissingMail();
    }, vars.MISSING_MAIL_TIMEOUT);

    updateDisplayState();
    calcQueueRemainingTime();
    io.emit('message', {type: messages.EV_KEY_WENT_MISSING, state: state});
    publisher.publish(JSON.stringify(state), '/state', true);
    hipchatIntegration.notifyKeyMissing();
}

function onKeyMissingMail() {
    logger.info('sending missing email');
    publisher.publish('MAIL', '/event');

    internalState.timerMissing = undefined;

    if (!state.debugMode) {
        // send mail to EVERYONE!
        var diff = moment.duration(moment(internalState.keyTakenOn).diff(moment())).humanize();
        sendMissingMail({}, {"missing_since": diff});
    }
}

function onKeyReturned() {
    if (state.keyPresent) {
        logger.warn('illegal state - ignoring returned event');
    } else {
        logger.info('key was RETURNED');
        publisher.publish('RETURNED', '/event');

        state.keyPresent = true;
        state.keyMissing = false;
        state.keyMissingSince = undefined;
        internalState.keyTakenOn = undefined;
        if (internalState.timerMissing) {
            clearTimeout(internalState.timerMissing);
        }

        updateQueueTimer();
        calcQueueRemainingTime();

        updateDisplayState();
        io.emit('message', {type: messages.EV_KEY_RETURNED, state: state});
        publisher.publish(JSON.stringify(state), '/state', true);
        hipchatIntegration.notifyKeyReturned();
    }
}

function onEnqueueRequest(clientId, replyFn) {
    logger.info('enqueue requested from %s', clientId);
    if (addToQueue(clientId)) {
        if (replyFn) {
            replyFn('DONE!' + clientId);
        }
    } else {
        if (replyFn) {
            replyFn('FAIL! mayby already enqueued, client ' + clientId);
        }
    }
}

function onLeaveQueueRequest(clientId, replyFn) {
    logger.info('leave queue requested from %s', clientId);
    removeFromQueue(clientId);
    if (replyFn) {
        replyFn('DONE! ' + clientId);
    }
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
    var clientId = (socket.request.session.clientId || shortid.generate());
    getConnectionList(clientId).push(socket.id);

    logger.info('a client connected from %s (%s)', socket.client.conn.remoteAddress, socket.id);
    publisher.publish('CONNECT', '/client');

    logger.debug('connect headers', socket.request.headers);

    // pass jwt back to hipchat integration
    if (socket.request.headers.referer) {
        var jwt = url.parse(socket.request.headers.referer, true).query.signed_request;
        if (jwt) {
            hipchatIntegration.handleSocketJwt(clientId, jwt);
        }
    }

    calcQueueRemainingTime();
    socket.send({type: messages.HELLO, state: state, clientId: clientId});

    socket.on('message', function (msg, replyFn) {
        clientId = socket.request.session.clientId;

        logger.debug('received message (%s): ', socket.id, msg);
        logger.debug('message headers', socket.request.headers);

        switch(msg.type) {
            case messages.REQ_ENQUEUE:
                publisher.publish('ENQUEUE', '/queue');
                onEnqueueRequest(clientId, replyFn);
                break;

            case messages.REQ_LEAVE_QUEUE:
                publisher.publish('LEAVE', '/queue');
                onLeaveQueueRequest(clientId, replyFn);
                break;
        }
    });

    socket.on('close', function() {
        logger.info('a client closed (%s)', socket.id);
        publisher.publish('CLOSE', '/client');
    });

    socket.on('disconnect', function() {
        logger.info('a client disconnected (%s)', socket.id);
        publisher.publish('DISCONNECT', '/client');
        // delay cleaning up to support browser reload
        setTimeout(function() {
            if (removeFromConnectionList(clientId, socket.id) && !hipchatIntegration.isHipchatUser(clientId)) {
                logger.info('last connection for client %s - cleaning up', clientId);
                removeFromQueue(clientId);
            }
        }, vars.CLEANUP_DELAY);
    });
});

function initServer(nconf) {
    if (nconf.get('enableSSL')) {
        var serverOptions = {
            key: fs.readFileSync(nconf.get('privateKey')),
            cert: fs.readFileSync(nconf.get('certificate'))
        };

        http.createServer(function (req, res) {
            res.writeHead(301, { "Location": "https://" + req.headers['host'] + req.url });
            res.end();
        }).listen(80);

        return https.createServer(serverOptions, app)
    }

    return http.createServer(app);
}

server.listen(nconf.get('port'), function () {
    var addr = server.address();
    logger.info("listening on %s:%d", addr.address, addr.port);
});
