/**
 * Created by martin on 12.06.2015.
 */
"use strict";

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


var app = angular.module('klokey', ['ngAnimate']);

app.factory('KloKeyService', function() {
    var kloKeyService = this;
    var notifications = [];
    var reservationNotification;

    var socket = io();

    kloKeyService.socket = socket;

    // Request permission before first notification
    if (window.Notification && Notification.permission !== "granted") {
        Notification.requestPermission(function (permission) {
            if (permission !== "granted") {
                console.error('Permission not granted');
            }
        });
    }

    kloKeyService.notifyKeyMissing = function() {
        Notification.requestPermission(function (permission) {
            if (permission === "granted") {
                notifications.push(new Notification("Toilettenschlüssel ist weg",
                    {tag: 'keyMissing', body: 'Der Toilettenschlüssel wird vermisst. Bitte check\' doch mal deine Hosentaschen.', icon:'/klo.jpg'}));
            }
        });
    };

    kloKeyService.notifyKeyReturned = function() {
        Notification.requestPermission(function (permission) {
            if (permission === "granted") {
                var returnedNotification = new Notification("Alles cool, der Schlüssel ist wieder da.",
                    {tag: 'keyMissing', icon:'/klo.jpg'});
                setTimeout(function() {
                    returnedNotification.close();
                }, 3000);
            }
        });

        notifications.forEach(function(n) {
            n.close();
        });
        notifications = [];
    };

    kloKeyService.notifyReservationReady = function(remainingTime) {
        if (!reservationNotification) {
            Notification.requestPermission(function (permission) {
                if (permission === "granted") {
                    reservationNotification = new Notification("Schlüssel bereit",
                        {tag: 'keyReady', body: 'Der Toilettenschlüssel liegt ab jetzt für die nächsten '+remainingTime+
                        ' Sekunden für dich bereit.', icon:'/golden_key_icon.png'});
                }
            });
        }
    };

    kloKeyService.closeReservationReadyNotification = function() {
        if (reservationNotification) {
            reservationNotification.close();
            reservationNotification = null;
        }
    };

    kloKeyService.isInQueue = function(queue, clientId) {
        var isInQueue = false;
        if (queue) {
            angular.forEach(queue, function(it) {
                if (it.clientId === clientId) {
                    isInQueue = true;
                }
            });
        }
        return isInQueue;
    };

    kloKeyService.enqueue = function() {
        socket.send({type: messages.REQ_ENQUEUE}, function(response) {
            console.log('RESPONSE: ', response);
        });
    };

    kloKeyService.leaveQueue = function() {
        socket.send({type: messages.REQ_LEAVE_QUEUE}, function(response) {
            console.log('RESPONSE: ', response);
        });
    };

    return kloKeyService;
});

app.controller("MainController", function($scope, KloKeyService) {
    var socket = KloKeyService.socket;

    $scope.clientId = null;

    $scope.enqueue = function() {
        if ($scope.isInQueue) {
            KloKeyService.leaveQueue();
        } else {
            KloKeyService.enqueue();
        }
    };

    socket.on('disconnect', function() {
        console.log('connection disconnected');
        $scope.state = null;
    });

    socket.on('message', function (data) {
        console.log('received message: ', data);
        var wasMissing = $scope.state && $scope.state.keyMissing;
        $scope.state = data.state;

        if (data.type === messages.HELLO) {
            $scope.clientId = data.clientId;
            console.log('HELLO');
        } else if (data.type === messages.EV_KEY_WENT_MISSING) {
            KloKeyService.notifyKeyMissing();
        } else if (data.type === messages.EV_KEY_RETURNED && wasMissing) {
            KloKeyService.notifyKeyReturned();
        }

        $scope.isInQueue = KloKeyService.isInQueue(data.state.queue, $scope.clientId);

        if (data.state && data.state.queue) {
            angular.forEach(data.state.queue, function(it) {
                if (it.expires) {
                    it.remaining = (it.expires - Date.now()) / 1000;
                }
            });
        }


        $scope.$apply();
    });


    function updateTimer() {
        if ($scope.state) {
            angular.forEach($scope.state.queue, function(it) {
                if (it.expires) {
                    it.remaining = ((it.expires - Date.now()) / 1000);
                    $scope.$apply();
                }
            });
        }
        setTimeout(updateTimer, 100);
    }
    setTimeout(updateTimer, 100);


});

app.controller("DialogController", function($scope, KloKeyService) {
    var socket = KloKeyService.socket;

    $scope.isDarkTheme = location.href.lastIndexOf("theme=dark") >= 0;

    $scope.clientId = null;
    $scope.state = {};
    $scope.messages = [];

    $scope.enqueue = KloKeyService.enqueue;
    $scope.leaveQueue = KloKeyService.leaveQueue;

    socket.on('message', function (data) {
        console.log('received message: ', data);

        var wasMissing = $scope.state && $scope.state.keyMissing;

        $scope.clientId = data.clientId || $scope.clientId;
        $scope.state = data.state;
        $scope.messages.push(data);
        $scope.isInQueue = KloKeyService.isInQueue(data.state.queue, $scope.clientId);

        if (data.type === messages.EV_RESERVATION_REMOVED) {
            $scope.reservationSuccess = data.success;
        } else if (data.type === messages.EV_KEY_WENT_MISSING) {
            KloKeyService.notifyKeyMissing();
        } else if (data.type === messages.EV_KEY_RETURNED && wasMissing) {
            KloKeyService.notifyKeyReturned();
        }

        if (data.state.keyMissingSince) {
            $scope.keyMissingSince = moment(data.state.keyMissingSince).format("LT");
        } else {
            $scope.keyMissingSince = undefined;
        }

        if (data.state.queue.length > 0 && data.state.queue[0].expiresIn) {
            var first = data.state.queue[0];
            $scope.expiresAt = Date.now() + first.expiresIn;
            $scope.expiryTime = first.expiryTime;
            updateQueueTimer();
        } else {
            $scope.expiresAt = null;
        }

        function updateQueueTimer() {
            var now = Date.now();
            if ($scope.expiresAt && $scope.expiresAt > now) {
                var expiresIn = $scope.expiresAt - now;
                $scope.remainingTime = Math.ceil((expiresIn / 1000));
                $scope.remainingPercent = (expiresIn / $scope.expiryTime) * 100;
                setTimeout(updateQueueTimer, 100);
            } else {
                $scope.expiresAt = null;
            }
            $scope.$apply();
        }

        if (data.state.keyPresent && data.state.queue.length > 0 && data.state.queue[0].clientId === $scope.clientId) {
            console.log("READY!");
            KloKeyService.notifyReservationReady($scope.remainingTime);
        } else {
            KloKeyService.closeReservationReadyNotification();
        }



        $scope.$apply();
    });

    socket.on('disconnect', function() {
        console.log('connection disconnected');
        $scope.state = null;
    });
});
