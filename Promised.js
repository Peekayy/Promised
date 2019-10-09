module.exports = (function () {
    const http = require("http");
    const https = require("https");
    const util = require("util");
    const querystring = require("querystring");
    const fs = require("fs");
    const Crypto = require("crypto");
    const path = require("path");
    const URL = require("url");
    const zlib = require("zlib");
    let Promised;

    function debug() {
        if (Promised.logger.debug) {
            Promised.logger.debug.apply(Promised.logger.debug, arguments);
        }
    }

    /**
     * @param {String} method
     * @param {URL} reqParams
     * @param {Object} data
     * @return {Promise}
     * @private
     */
    function httpReq(method, reqParams, data) {
        const deferred = Promised.defer();
        const proxy = process.env.http_proxy || process.env.HTTP_PROXY;
        if (proxy) {
            const proxyUrl = URL.parse(proxy);
            const path = reqParams.protocol + "//" + reqParams.host + reqParams.path;
            Object.assign(reqParams, proxyUrl);
            reqParams.path = path;
        }

        let requester;
        if (reqParams.protocol === "http:") {
            requester = http;
        } else if (reqParams.protocol === "https:") {
            requester = https;
        } else {
            return Promise.reject(new Error(`Unsupported protocol '${reqParams.protocol}'`));
        }

        const req = requester.request(Object.assign({method: method}, reqParams), function (res) {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                deferred.reject(new Error(res.statusCode + " - " + res.statusMessage + " : " + reqParams.href));
            } else {
                deferred.resolve(res);
            }
        });

        req.on("error", function (err) {
            deferred.reject(err);
        });

        if (!data) {
            req.end();
        } else {
            switch (typeof data) {
                case "object":
                    data = JSON.stringify(data);
                case "string" :
                    req.write(data);
                    req.end();
                    break;
                default:
                    if (data instanceof fs.ReadStream) {
                        data.pipe(req);
                    } else {
                        req.write(querystring.stringify(data));
                        req.end();
                    }
                    break;
            }
        }
        return deferred.promise;
    }

    Promised = {
        logger: console,
        install: function () {
            Promise.prototype.delay = function (delay) {
                return this.then(e => Promised.delay(delay).then(_ => e));
            };
        },
        httpGET: function (reqParams) {
            return httpReq("GET", reqParams);
        },
        httpPOST: function (reqParams, data) {
            return httpReq("POST", reqParams, data);
        },
        httpHEAD: function (reqParams) {
            return httpReq("HEAD", reqParams);
        },
        httpPUT: function (reqParams, data) {
            return httpReq("PUT", reqParams, data);
        },
        httpResponseHandler: {
            simpleData: function (res) {
                let data = "", deferred = Promised.defer();
                res.on('data', function (chunk) {
                    data += chunk;
                });
                res.on('end', function () {
                    deferred.resolve(data);
                });
                return deferred.promise;
            },
            buffer: function (res) {
                const buffers = [], deferred = Promised.defer();
                res.on('data', function (chunk) {
                    buffers.push(chunk);
                });
                res.on('end', function () {
                    deferred.resolve(Buffer.concat(buffers));
                });
                return deferred.promise;
            },
            json: function (res) {
                return Promised.httpResponseHandler.simpleData(res).then(data => JSON.parse(data));
            },
            xml: function (res) {
                return Promised.httpResponseHandler.simpleData(res).then(Promised.parseXml);
            },
            headers: function (res) {
                return Promise.resolve(res.headers);
            },
            gzip: function (res) {
                return Promised.httpResponseHandler.buffer(res).then(data => {
                    return new Promise((resolve, reject) => {
                        zlib.gunzip(data, (err, gunzippedData) => {
                            if (err) {
                                reject(err);
                            } else {
                                resolve(gunzippedData);
                            }
                        });
                    });
                });
            },
            hls: function (mode, baseUrl) {
                return function (res) {
                    return Promised.httpResponseHandler.m3u8(res).then(function (m3u) {
                        m3u.items.StreamItem.sort(function (a, b) {
                            return parseInt(a.attributes.attributes.bandwidth) - parseInt(b.attributes.attributes.bandwidth);
                        });
                        let selectedStreams;
                        switch (mode) {
                            case "STREAMS":
                                // returns only streams infos
                                break;
                            case "FULL":
                            case "ALL":
                                // Retrieves ts list for all streams
                                selectedStreams = m3u.items.StreamItem;
                                break;
                            case "WORST":
                                // Retrieves only worst quality stream and ts info
                                selectedStreams = [m3u.items.StreamItem[0]];
                                break;
                            case "BEST":
                            default:
                                // Retrieves only worst quality stream and ts info
                                selectedStreams = [m3u.items.StreamItem[m3u.items.StreamItem.length - 1]];
                                break;
                        }

                        return selectedStreams.reduce(function (chain, stream) {
                            return chain.then(function () {
                                return URL.parse(stream.properties.uri);
                            }).then(function (streamUrl) {
                                let params = Object.assign({}, baseUrl, {
                                    hostname: streamUrl.hostname || (baseUrl && baseUrl.hostname),
                                    path: (baseUrl && baseUrl.path && !streamUrl.path.includes(baseUrl.path) || "") + streamUrl.path
                                });
                                return Promised.httpGET(params);
                            }).then(Promised.httpResponseHandler.m3u8).then(m3u => {
                                stream.content = m3u;
                                return stream;
                            });
                        }, Promise.resolve()).then(_ => selectedStreams);

                    });
                }
            },
            pipeToFile: function (path) {
                return function (res) {
                    const deferred = Promised.defer();

                    const tsFile = fs.createWriteStream(path);

                    tsFile.on("finish", function () {
                        tsFile.end();
                        deferred.resolve(path);
                    });

                    tsFile.on("error", function (error) {
                        deferred.reject("Couldn't write " + path + ":" + error);
                    });

                    if (res.statusCode !== 200) {
                        tsFile.end();
                        res.socket.end();
                        deferred.reject("Couldn't get file '" + path + "' statusCode  : " + res.statusCode);

                    } else {
                        res.pipe(tsFile);
                    }

                    return deferred.promise;
                }
            }
        },
        md5sum: function (filepath) {
            const deferred = Promised.defer();
            const stream = fs.ReadStream(filepath);
            const md5 = Crypto.createHash("md5");

            stream.on("data", function (data) {
                md5.update(data);
            });
            stream.on("end", function () {
                deferred.resolve(md5.digest("hex"));
            });

            return deferred.promise;
        },
        allLimit: function (tasks, limit) {
            const queues = [];
            const results = [];

            for (let i = 0; i < tasks.length; i++) {
                if (!queues[i % limit]) {
                    queues[i % limit] = [];
                }
                queues[i % limit].push(tasks[i]);
            }

            return Promise.all(queues.map(function (queue, queueIndex) {
                return queue.reduce(function (chain, task, i) {
                    return chain.then(task).then(function (result) {
                        results[i * limit + queueIndex] = result;
                    });
                }, Promise.resolve());
            })).then(_ => results);
        },
        downloadFiles: function (urls, filenames, targetFolder, maxParallelDownloads) {
            if (!filenames) {
                filenames = [];
            }
            const queues = [];

            for (let i = 0; i < urls.length; i++) {
                if (!queues[i % maxParallelDownloads]) {
                    queues[i % maxParallelDownloads] = [];
                }
                queues[i % maxParallelDownloads].push({url: urls[i], filename: filenames[i], index: i});
            }
            return Promise.all(queues.map(function (queue) {
                return queue.reduce(function (chain, item) {
                    return chain.then(function () {
                        return Promised.downloadFile(item.url, item.filename, targetFolder);
                    }).then(function (filename) {
                        item.filename = filename;
                    }).catch(function (err) {
                        item.error = err;
                        return Promise.reject(err);
                    });
                }, Promise.resolve());
            })).then(function () {
                return queues.reduce(function (array, queue) {
                    return array.concat(queue);
                }, []).sort(function (a, b) {
                    return a.index - b.index;
                });
            });
        },
        downloadFile: function (url, filename, targetFolder) {
            if (!filename) {
                filename = url.pathname.split("/").pop();
            }
            if (targetFolder) {
                filename = targetFolder + path.sep + filename;
            }
            return Promised.tryPromise(Promised.httpGET, [url], 10).then(Promised.httpResponseHandler.pipeToFile(filename));
        },
        fs: {
            mkdir: util.promisify(fs.mkdir),
            unlink: util.promisify(fs.unlink),
            rmdir: util.promisify(fs.rmdir),
            readdir: util.promisify(fs.readdir),
            open: util.promisify(fs.open),
            write: util.promisify(fs.write),
            writeFile: util.promisify(fs.writeFile),
            readFile: util.promisify(fs.readFile),
            close: util.promisify(fs.close),
            stat: util.promisify(fs.stat),
            chmod: util.promisify(fs.chmod),
            removeDirAndContents: function (dir) {
                return Promised.fs.readdir(dir).then(function (files) {
                    return Promise.all(files.map(function (file) {
                        return Promised.fs.unlink(dir + path.sep + file);
                    }));
                }).then(function () {
                    return Promised.fs.rmdir(dir);
                });
            }
        },
        tryPromise: function (f, args, maxTries, delay) {
            return (f(args) || Promise.resolve()).catch(function (err) {
                debug("Error occurred", err);
                if (maxTries || maxTries === 0) {
                    debug("Left attempts : " + maxTries);
                } else {
                    debug("Retrying...");
                }
                if (maxTries || typeof maxTries !== "number") {
                    return Promised.delay(delay || 0).then(function () {
                        return Promised.tryPromise(f, args, maxTries ? maxTries - 1 : null, delay);
                    });
                } else {
                    return Promise.reject(err);
                }
            });
        },
        yql: function (query) {
            let queryUrl = URL.parse("https://query.yahooapis.com/v1/public/yql?q=" + encodeURIComponent(query) + "&format=json&callback=");
            return Promised.httpsGET(queryUrl).then(Promised.httpResponseHandler.json, (res) => {
                throw new Error(res.statusCode + " - " + res.statusMessage);
            });
        },
        defer: function () {
            let deferred = {};
            deferred.promise = new Promise((resolve, reject) => {
                deferred.resolve = resolve;
                deferred.reject = reject;
            });
            return deferred;
        },
        delay: function (delay) {
            const deferred = Promised.defer();
            setTimeout(_ => {
                deferred.resolve();
            }, delay);
            return deferred.promise;
        }
    };

    try {
        const prompt = require("prompt");
        Promised.prompt = function (fields) {
            prompt.start();
            const deferred = Promised.defer();
            prompt.get(fields, function (err, results) {
                if (err) {
                    deferred.reject(err);
                } else {
                    deferred.resolve(results);
                }
            });
            return deferred.promise;
        }
    } catch (e) {
        Promised.prompt = function () {
            throw new Error("Missing peer dependency 'prompt'");
        }
    }

    try {
        const m3u8 = require("m3u8");
        Promised.httpResponseHandler.m3u8 = function (res) {
            const deferred = Promised.defer();
            if (res.statusCode !== 200) {
                deferred.reject("Couldn't get m3u8 playlist : " + res.statusCode);
            } else {
                const parser = m3u8.createStream();
                res.pipe(parser);

                parser.on("m3u", function (m3u) {
                    deferred.resolve(m3u);
                });
            }
            return deferred.promise;
        }
    } catch (e) {
        Promised.httpResponseHandler.m3u8 = function () {
            throw new Error("Missing peer dependency 'm3u8'");
        }
    }

    try {
        const xml2js = require("xml2js").Parser({
            normalizeTags: true,
            explicitArray: false,
            trim: true,
            normalize: true
        });
        Promised.parseXml = function (string) {
            const deferred = Promised.defer();
            xml2js.parseString(string, function (err, result) {
                if (err) {
                    deferred.reject(err);
                } else {
                    deferred.resolve(result);
                }
            });
            return deferred.promise;
        };
    } catch (e) {
        Promised.parseXml = function () {
            throw new Error("Missing peer dependency 'xml2js'");
        }
    }

    return Promised;

})();
