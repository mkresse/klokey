"use strict";

var fs = require('fs');
var winston = require('winston');
var Promise = require('promise');
var request = require('request');
var jwtUtil = require('jwt-simple');
var moment = require('moment');
var _ = require('underscore');
var handlebars = require('handlebars');

//require('request').debug = true

var EventEmitter =  require('events').EventEmitter;

var logger;
var doSendNotification = true;
var wasMissing = false;

exports.init = function(app, options, state, serverLogger) {
    logger = serverLogger || winston;

    var eventEmitter = new EventEmitter();
    var storeData = readStoreData();
    var tokenPromises = {};
    var clientIdToUserId = {};

    app.get('/capabilities', function (req, res) {
        var file = fs.readFileSync('capabilities.json', {encoding: 'utf8'});
        var capabilities = handlebars.compile(file)({BASE_URL: options.base_url});
        res.json(JSON.parse(capabilities));
    });


    app.post('/installed', function (req, res) {
        var installData = req.body;
        logger.debug("install hook called: ", installData);

        performRequest(installData.capabilitiesUrl).then(
            function(response) {
                // store oauthId, oauthSecret, roomId, capabilitiesURL and fetched capabilities
                storeInstallData(storeData, installData, JSON.parse(response).capabilities);
                res.status(200).end();
            },
            function(err) {
                logger.error(err);
                res.status(500).end();
            }
        );
    });

    app.get('/glance', function (req, res) {
        var response = statusContentFromState(state);
        res.json(response);

        var jwt = jwtUtil.decode(req.query.signed_request, null, true);
        logger.debug("/glance called: clientId=%s, jwt=", req.session.clientId, jwt);
        logger.debug("response status sent: ", response);
    });

    function associateClientIdWithUserId(clientId, jwtString) {
        var jwt = jwtUtil.decode(jwtString, null, true);
        if (jwt) {
            logger.debug("associate " + clientId + " to " + jwt.sub);
            clientIdToUserId[clientId] = jwt.sub;
        }
    }

    function updateToken(storeData, room) {
        var httpOptions = {
            "url": room.capabilities.oauth2Provider.tokenUrl,
            "method": 'POST',
            "auth": {
                "user": room.installed.oauthId,
                "pass": room.installed.oauthSecret
            },
            form: {grant_type:'client_credentials', scope:'send_notification'}
        };

        return performRequest(httpOptions).then(function(response) {
            logger.info("success getting token: ", response);
            storeAuthData(storeData, room.key, JSON.parse(response));
            return true;
        });
    }

    function checkToken(room) {
        // check if there is already a token request in progress
        if (tokenPromises[room.key]) {
            logger.debug("token update in progress");
            return tokenPromises[room.key];
        }

        // check if there is a valid token available
        if (room.auth && room.authExpiresAt) {
            var isExpired = moment().isAfter(moment(room.authExpiresAt, moment.ISO_8601));
            if (!isExpired) {
                return Promise.resolve(true);
            }
            logger.debug("token is expired");
        }

        // a (new) token is required
        logger.debug("require new token");
        var promise = updateToken(storeData, room);
        tokenPromises[room.key] = promise;
        promise.then(function() {
            tokenPromises[room.key] = null;
        }, function() {
            logger.error('unable to update token');
            tokenPromises[room.key] = null;
        });

        return promise;
    }


    function sendNotification(notifyRequest) {
        if (doSendNotification) {
            _.each(storeData, function(room) {
                checkToken(room).then(function() {
                    var httpOptions = {
                        url: options.server + "/v2/room/" + room.installed.roomId + "/notification",
                        method: 'POST',
                        json: notifyRequest,
                        agentOptions: { rejectUnauthorized: false },
                        auth: {
                            bearer: room.auth.access_token
                        }
                    };

                    logger.debug("notifying hipchat to %s: ", room.key, notifyRequest);
                    performRequest(httpOptions, room);
                });
            });
        }
    }

    function sendGlanceUpdate() {
        _.each(storeData, function(room) {
            checkToken(room).then(function () {
                var glanceData = {
                    "glance": [
                        {
                            "key": "klokey-glance",
                            "content": statusContentFromState(state)
                        }
                    ]
                };

                var httpOptions = {
                    url: options.server + "/v2/addon/ui/room/" + room.installed.roomId,
                    method: 'POST',
                    json: glanceData,
                    agentOptions: { rejectUnauthorized: false },
                    auth: {
                        bearer: room.auth.access_token
                    }
                };

                logger.debug("sending glance update to %s: ", room.key, glanceData);
                performRequest(httpOptions, room);
            });
        });
    }

    var hipChatHandle = {
        "on": eventEmitter.on,

        "isHipchatUser": function(clientId) {
            return clientIdToUserId[clientId] ? true : false;
        },

        "notifyKeyTaken": function() {
            sendGlanceUpdate();
        },

        "notifyKeyMissing": function() {
            wasMissing = true;

            sendGlanceUpdate();
            sendNotification({
                "color": "red",
                "message": "Oh nein, der Kloschlüssel ist weg (sadpanda) Check doch bitte mal deine Hosentasche...",
                "notify": true,
                "message_format":"text"
            });
            /*sendNotification({
                "color": "red",
                "message": "It works! Code Red (yay)",
                "notify": true,
                "from": "from",
                "message_format":"text",
                "card": {
                    "style": "application",
                    "format": "medium",
                    "id": "db797a68-0aff-4ae8-83fc-2e72dbb1a707",
                    "title": "Keytest: Code Red!",
                    "description": {
                        "value": "This is a <b>description</b> of an application object.\nwith 2 lines of text",
                        "format": "html"
                    },
                    "icon": {
                        "url": "http://bit.ly/1S9Z5dF"
                    },
                    "attributes": []
                }
            });*/
        },

        "notifyKeyReturned": function() {
            sendGlanceUpdate();
            if (wasMissing) {
                wasMissing = false;
                sendNotification({
                    "color": "green",
                    "message": "Alles cool, der Kloschlüssel ist zurück. (awesome)",
                    "notify": true,
                    "message_format":"text"
                });
            }
        },

        "notifyReservationQueued": function() {
            sendGlanceUpdate();
        },

        "notifyReservationRemoved": function() {
            sendGlanceUpdate();
        },

        "handleSocketJwt": function(clientId, jwt) {
            associateClientIdWithUserId(clientId, jwt);
        }
    };

    logger.info("HIPCHAT initialized");

    eventEmitter.emit("initialized");

    return hipChatHandle;
};


function getStoreKey(groupId, roomId) {
    return groupId + "#" + roomId;
}

function storeInstallData(storeData, installed, capabilities) {
    var key = getStoreKey(installed.groupId, installed.roomId);
    storeData[key] = {
        key: key,
        installed: installed,
        capabilities: capabilities,
        auth: null,
        authExpiresAt: null
    };

    writeStoreData(storeData);
}

function storeAuthData(storeData, key, auth) {
    if (storeData[key]) {
        storeData[key].auth = auth;
        storeData[key].authExpiresAt = moment().add(auth.expires_in, "seconds").toISOString();
        writeStoreData(storeData);
    } else {
        logger.error("unable to find store data for ", key);
    }
}

function writeStoreData(storeData) {
    fs.writeFileSync('data.json', JSON.stringify(storeData));
}

function readStoreData() {
    var storeData = {};

    if (fs.existsSync('data.json')) {
        var file = fs.readFileSync('data.json', {encoding:'utf8'});
        storeData = JSON.parse(file);
        logger.info('Read install data:', storeData);
    }

    return storeData;
}

function performRequest(httpOptions, room) {
    return new Promise(function (resolve, reject) {
        request(httpOptions, function (error, response, body) {
            if (!error) {
                if (response.statusCode >= 200 && response.statusCode <= 299) {
                    logger.debug("request - success: ", httpOptions, body);
                    resolve(body);
                } else {
                    logger.error("request - wrong status code: " + response.statusCode, httpOptions);
                    reject("wrong status code: " + response.statusCode, httpOptions);
                    if (room && response.statusCode === 401) {
                        // force token update next time
                        room.auth = null;
                        room.authExpiresAt = null;
                    }
                }
            } else {
                logger.error("request - error while calling hipchat: ", error);
                reject("error while calling hipchat: " + error, httpOptions);
            }
        });
    });
}


function statusContentFromState(state) {
    var statusValue;

    if (state.keyPresent) {
        if (state.queue.length === 1) {
            statusValue = {"label": "RESERVIERT", "type": "current"};
        } else if (state.queue.length > 1) {
            var queue = " (" + state.queue.length + ")";
            statusValue = {"label": "RESERVIERT" + queue, "type": "current" };
        } else {
            statusValue = {"label": "FREI", "type": "success" };
        }
    } else {
        if (state.keyMissing) {
            statusValue = {"label": "VERMISST", "type": "error"};
        } else {
            statusValue = {"label": "BESETZT", "type": "current"};
        }
    }

    return {
        "label": {
            "type": "html",
            "value": "Kloschlüssel"
        },
        "status": {
            "type": "lozenge",
            "value": statusValue
        }
    };
}
