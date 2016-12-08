"use strict";

var fs = require('fs');
var Promise = require('promise');
var request = require('request');
var jwtUtil = require('jwt-simple');
var _ = require('underscore');

//require('request').debug = true

var EventEmitter =  require('events').EventEmitter;

exports.init = function(app, options, state) {
    var eventEmitter = new EventEmitter();
    var storeData = readStoreData();
    var tokenPromises = {};

    app.get('/capabilities', function (req, res) {
        res.json({
            "name": "KloKey Addon",
            "description": "some test integration",
            "vendor": {
                "name": "EsPresto AG",
                "url": "http://www.espresto.com"
            },
            "links": {
                "self": "https://klokey.yetanotherserver.net/capabilities"
            },
            "key": "com.espresto.klokey",
            "capabilities": {
                "installable": {
                    "allowGlobal": false,
                    "allowRoom": true,
                    "callbackUrl": "https://klokey.yetanotherserver.net/installed",
                    "updateCallbackUrl": "https://klokey.yetanotherserver.net/updated"
                },

                "hipchatApiConsumer": {
                    "scopes": [
                        "send_notification"
                    ]
                },

                "glance": [
                    {
                        "name": {
                            "value": "Cooles KloKey addon glance"
                        },
                        "queryUrl": "https://klokey.yetanotherserver.net/glance",
                        "key": "myaddon-glance",
                        "target": "myaddon-sidebar",
                        "icon": {
                            "url": "https://upload.wikimedia.org/wikipedia/commons/thumb/d/de/Golden_key_icon.svg/600px-Golden_key_icon.svg.png",
                            "url@2x": "https://upload.wikimedia.org/wikipedia/commons/thumb/d/de/Golden_key_icon.svg/600px-Golden_key_icon.svg.png"
                        },
                        "conditions": []
                    }
                ]
            }

        });
    });


    app.post('/installed', function (req, res) {
        var installData = req.body;
        console.log("install data: ", installData);

        performRequest(installData.capabilitiesUrl).then(
            function(response) {
                // store oauthId, oauthSecret, roomId, capabilitiesURL and fetched capabilities
                storeInstallData(storeData, installData, JSON.parse(response).capabilities);
                res.status(200).end();
            },
            function(err) {
                console.error(err);
                res.status(500).end();
            }
        );
    });

    app.get('/glance', function (req, res) {
        res.json({
            "label": {
                "type": "html",
                "value": "Kloschlüssel"
            },
            "status": statusFromState(state),
            "metadata": {}
        });

        var jwt = jwtUtil.decode(req.query.signed_request, null, true);
        console.log("/glance called: jwt=", jwt);
        console.log("response status sent: ", statusFromState(state));
    });

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
            console.log("success getting token: ", response);
            storeAuthData(storeData, room.key, JSON.parse(response));
            return true;
        });
    }

    function checkToken(room) {
        if (tokenPromises[room.key]) {
            return tokenPromises[room.key];
        }

        // TODO: use "expires_in"
        if (!room.auth || !room.auth.isStillValid) {
            var promise = updateToken(storeData, room);
            tokenPromises[room.key] = promise;
            promise.then(function() {
                tokenPromises[room.key] = null;
            });

            return promise;
        }

        return Promise.resolve(true);
    }


    function sendNotification(notifyRequest) {
        _.each(storeData, function(room) {
            checkToken(room).then(function() {
                var httpOptions = {
                    url: options.server + "/v2/room/" + room.installed.roomId + "/notification",
                    method: 'POST',
                    json: notifyRequest,
                    auth: {
                        bearer: room.auth.access_token
                    }
                };

                console.log("notifying hipchat: ", notifyRequest);
                performRequest(httpOptions);
            });
        });
    }

    function sendGlanceUpdate() {
        _.each(storeData, function(room) {
            checkToken(room).then(function () {
                var glanceData = {
                    "glance": [
                        {
                            "key": "myaddon-glance",
                            "content": {
                                "label": {
                                    "type": "html",
                                    "value": "Kloschlüssel"
                                },
                                "status": statusFromState(state)
                            }
                        }
                    ]
                };

                var httpOptions = {
                    url: options.server + "/v2/addon/ui/room/" + room.installed.roomId,
                    method: 'POST',
                    json: glanceData,
                    auth: {
                        bearer: room.auth.access_token
                    }
                };

                console.log("sending glance update: ", glanceData);
                performRequest(httpOptions);
            });
        });
    }

    var hipChatHandle = {
        "on": eventEmitter.on,

        "notifyKeyTaken": function() {
            sendGlanceUpdate();
        },

        "notifyKeyMissing": function() {
            sendGlanceUpdate();
            sendNotification({
                "color": "red",
                "message": "Schlüssel weg",
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
            sendNotification({
                "color": "green",
                "message": "Schlüssel zurück",
                "notify": true,
                "message_format":"text"
            });
        }
    };

    console.log("HIPCHAT initialized");

    eventEmitter.emit("initialized");

    return hipChatHandle;
};


function getStoreKey(groupId, roomId) {
    return groupId + "#" + roomId;
}

function storeInstallData(storeData, installed, capabilitis) {
    var key = getStoreKey(installed.groupId, installed.roomId);
    storeData[key] = {
        key: key,
        installed: installed,
        capabilities: capabilitis
    };

    writeStoreData(storeData);
}

function storeAuthData(storeData, key, auth) {
    if (storeData[key]) {
        storeData[key].auth = auth;
        writeStoreData(storeData);
    } else {
        console.error("unable to find store data for ", key);
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
        console.log('Read install data:', storeData);
    }

    return storeData;
}

function performRequest(httpOptions) {
    return new Promise(function (resolve, reject) {
        request(httpOptions, function (error, response, body) {
            if (!error) {
                if (response.statusCode >= 200 && response.statusCode <= 299) {
                    console.log("success: ", body);
                    resolve(body);
                } else {
                    console.error("wrong status code: ", response.statusCode);
                    reject("wrong status code: " + response.statusCode);
                }
            } else {
                console.error("error while calling hipchat: ", error);
                reject("error while calling hipchat: " + error);
            }
        });
    });
}


function statusFromState(state) {
    var statusValue;

    if (state.keyPresent) {
        statusValue = {"label": "FREI", "type": "success" };
    } else {
        if (state.keyMissing) {
            statusValue = {"label": "VERMISST", "type": "error"};
        } else {
            statusValue = {"label": "BESETZT", "type": "current"};
        }
    }

    return {
        "type": "lozenge",
        "value": statusValue
    };
}
