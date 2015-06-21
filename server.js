"use strict";

var express = require('express');
var session = require('cookie-session');
var http = require('http');
var socket = require('socket.io');
var shortid = require('shortid');
var _ = require('underscore');

var app = express();
var server = http.createServer(app);
var io = socket(server);

var vars = {
    SESSION_NAME: 'kk_sess',
    SESSION_KEY: 'secr3t',
    CLEANUP_DELAY: 3000,
    MISSING_TIMEOUT: 5000,
    MISSING_MAIL_TIMEOUT: 3000
};

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

var internalState = {
    timer: undefined,
    clientConnectionsMap: {}
};

var sessionMiddleware = session({
    secret: vars.SESSION_KEY,
    name: vars.SESSION_NAME
});

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


function addToQueue(clientId) {
    if (!_.findWhere(state.queue, {clientId: clientId})) {
        state.queue.push({clientId: clientId});
        io.emit('message', {type: messages.EV_RESERVATION_QUEUED, state: state});
        return true;
    }

    return false;
}

function removeFromQueue(clientId) {
    state.queue = _.reject(state.queue, function(entry) {
        return entry.clientId === clientId;
    });
    io.emit('message', {type: messages.EV_RESERVATION_REMOVED, state: state});
}

function onKeyTaken() {
    if (!state.keyPresent) {
        console.warn('illegal state - ignoring taken event');
    } else {
        console.log('key was TAKEN');

        state.keyPresent = false;
        internalState.timer = setTimeout(function() {
            onKeyWentMissing();
        }, vars.MISSING_TIMEOUT);

        io.emit('message', {type: messages.EV_KEY_TAKEN, state: state});
    }
}

function onKeyWentMissing() {
    console.log('key went MISSING');

    state.keyMissing = true;
    internalState.timer = setTimeout(function() {
        onKeyMissingMail();
    }, vars.MISSING_MAIL_TIMEOUT);

    io.emit('message', {type: messages.EV_KEY_WENT_MISSING, state: state});
}

function onKeyMissingMail() {
    internalState.timer = undefined;

    // send mail to EVERYONE!
}

function onKeyReturned() {
    if (state.keyPresent) {
        console.warn('illegal state - ignoring returned event');
    } else {
        console.log('key was RETURNED');

        state.keyPresent = true;
        state.keyMissing = false;
        if (internalState.timer) {
            clearTimeout(internalState.timer);
        }

        io.emit('message', {type: messages.EV_KEY_RETURNED, state: state});
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

server.listen(3000, function () {
    var addr = server.address();
    console.log("listening on %s:%d", addr.address, addr.port);
});
