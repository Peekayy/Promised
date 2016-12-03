var should = require("chai").should();
var Qed = require("../");
var Q = require("q");


var values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];
var workersCounter = {
    count: 0,
    history: [],
    inc: function() {
        this.count++;
        this.history.push(this.count);
    },
    dec: function() {
        this.count--;
        this.history.push(this.count);
    }
};

describe("Qed", function() {
    describe("#allLimit()", function() {

        it("should return an array of results in the same order", function(done) {
            var tasks = [];

            function createTask(value) {
                return function() {
                    var deferred = Q.defer();
                    setTimeout(function() {
                        deferred.resolve(value);
                    }, Math.floor(Math.random() * 100));
                    return deferred.promise;
                };
            }

            for (var i = 0; i < values.length; i++) {
                tasks.push(createTask(values[i]));
            }

            Qed.allLimit(tasks, 2).then(function(results) {
                results.should.deep.equal(values);
            }).done(done);
        });

        it("should have limited concurrent workers", function(done) {

            var tasks = [];

            function createTask(value) {
                return function() {
                    workersCounter.inc();
                    var deferred = Q.defer();
                    setTimeout(function() {
                        deferred.resolve(value);
                        workersCounter.dec();
                    }, Math.floor(Math.random() * 100));
                    return deferred.promise;
                };
            }

            for (var i = 0; i < values.length; i++) {
                tasks.push(createTask(values[i]));
            }

            var limit = 10;

            Qed.allLimit(tasks, limit).then(function() {
                Math.max.apply(null, workersCounter.history).should.equal(limit);
            }).done(done);
        });
    });
    describe("#retry()", function() {
        it("should succeed after trying 10 times", function(done) {

            var nbAttempts = 0;

            Qed.tryPromise(function() {
                if (nbAttempts++ < 10) {
                    throw new Error("Not ready yet");
                }
            }, null, 10).done(done);
        });

        it("should retry until success", function(done) {

            var ctx = {ready: false};
            setTimeout(function() {
                ctx.ready = true;
            }, 1800);

            Qed.tryPromise(function() {
                if (!ctx.ready) {
                    throw new Error("Not ready yet");
                }
            }, null, null, 100).done(done);
        });
    });
});