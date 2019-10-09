require("chai").should();
const Promised = require("../");
const url = require("url");


const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];
const workersCounter = {
    count: 0,
    history: [],
    inc: function () {
        this.count++;
        this.history.push(this.count);
    },
    dec: function () {
        this.count--;
        this.history.push(this.count);
    }
};

describe("Promised", function () {
    describe("#allLimit()", function () {

        it("should return an array of results in the same order", function (done) {
            const tasks = [];

            function createTask(value) {
                return function () {
                    return Promised.delay(Math.floor(Math.random() * 100)).then(_ => {
                        return value;
                    });
                };
            }

            for (let i = 0; i < values.length; i++) {
                tasks.push(createTask(values[i]));
            }

            Promised.allLimit(tasks, 2).then(function (results) {
                results.should.deep.equal(values);
            }).then(done);
        });

        it("should have limited concurrent workers", function () {

            const tasks = [];

            function createTask(value) {
                return function () {
                    workersCounter.inc();
                    return Promised.delay(Math.floor(Math.random() * 100)).then(_ => {
                        workersCounter.dec();
                        return value;
                    });
                };
            }

            for (let i = 0; i < values.length; i++) {
                tasks.push(createTask(values[i]));
            }

            const limit = 10;

            return Promised.allLimit(tasks, limit).then(function () {
                Math.max.apply(null, workersCounter.history).should.equal(limit);
            });
        });
    });
    describe("#retry()", function () {
        it("should succeed after trying 10 times", function () {
            let nbAttempts = 0;
            return Promised.tryPromise(function () {
                if (nbAttempts++ < 10) {
                    return Promise.reject("Not ready yet");
                }
            }, null, 10);
        });

        it("should fail after failling 5 times", function (done) {
            let nbAttempts = 0;
            Promised.tryPromise(function () {
                if (nbAttempts++ < 6) {
                    return Promise.reject("Not ready yet");
                }
            }, null, 5).catch(function (err) {
                if (err === "Not ready yet") {
                    done();
                } else {
                    return Promise.reject(err);
                }
            });
        });

        it("should retry until success", function () {
            let ctx = {ready: false};
            setTimeout(function () {
                ctx.ready = true;
            }, 1800);

            return Promised.tryPromise(function () {
                if (!ctx.ready) {
                    return Promise.reject("Not ready yet");
                }
            }, null, null, 100);
        });
    });
    describe("#httpGet", function () {
        it("should succeed to request GET http://eu.httpbin.org/", function () {
            return Promised.httpGET(url.parse("http://eu.httpbin.org"));
        });

        it("should succeed to request GET https://eu.httpbin.org/", function () {
            return Promised.httpGET(url.parse("https://eu.httpbin.org"));
        });
    });

    describe("httpResponseHandlers", () => {
        describe("gzip", () => {
            it("should unzip gzipped data", async function () {
                const response = await Promised.httpGET(url.parse("https://httpbin.org/gzip"));
                let data = await Promised.httpResponseHandler.gzip(response);
                data = JSON.parse(data);
                data.gzipped.should.be.true;
            });
        });
    });
});
