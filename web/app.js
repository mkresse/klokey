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


var app = angular.module('klokey', ['ngMaterial']);

app.factory('KloKeyService', function() {
    var kloKeyService = this;
    var notifications = [];

    kloKeyService.notifyKeyMissing = function() {
        Notification.requestPermission(function (permission) {
            if (permission === "granted") {
                notifications.push(new Notification("Toilettenschlüssel ist weg",
                    {tag: 'keyMissing', body: 'Der Toilettenschlüssel ist weg. Bitte checke mal deine Hosentaschen.', icon:'/klo.jpg'}));
            }
        });
    };

    kloKeyService.notifyKeyReturned = function() {
        Notification.requestPermission(function (permission) {
            if (permission === "granted") {
                var returnedNotification = new Notification("Schüssel zurück",
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

    return kloKeyService;
});

app.controller("MainController", function($scope, KloKeyService) {
    var socket = io();

    $scope.clientId = null;

    $scope.enqueue = function() {
        if ($scope.isInQueue) {
            socket.send({type: messages.REQ_LEAVE_QUEUE}, function(response) {
                console.log('RESPONSE: ', response);
            });
        } else {
            socket.send({type: messages.REQ_ENQUEUE}, function(response) {
                console.log('RESPONSE: ', response);
            });
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

        $scope.isInQueue = false;
        if (data.state && data.state.queue) {
            angular.forEach(data.state.queue, function(it) {
                if (it.expires) {
                    it.remaining = (it.expires - Date.now()) / 1000;
                }
                console.log(it.clientId, ' =?', $scope.clientId);
                if (it.clientId === $scope.clientId) {
                    $scope.isInQueue = true;
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
