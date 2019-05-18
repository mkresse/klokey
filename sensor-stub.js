"use strict";

var EventEmitter =  require('events').EventEmitter;

// provide stub for non compatible systems
exports.init = function() {
    return new EventEmitter();
};
