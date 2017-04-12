module.exports = (function() {
    var http = require("http");
    var https = require("https");
    var extend = require("util")._extend;
    var querystring = require("querystring");
    var fs = require("fs");
    var Crypto = require("crypto");
    var path = require("path");
    var url = require("url");
    var Q = require("q");
    var Qed;

    function debug() {
        if (Qed.logger.debug) {
            Qed.logger.debug.apply(Qed.logger.debug, arguments);
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
        var deferred = Q.defer();
        var proxy = process.env.http_proxy || process.env.HTTP_PROXY;
        if (proxy) {
            var proxyUrl = url.parse(proxy);
            var path = reqParams.protocol + "//" + reqParams.host + reqParams.path;
            extend(reqParams, proxyUrl);
            reqParams.path = path;
        }

        var req = http.request(extend({method: method, port: 80}, reqParams), function(res) {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                deferred.reject(new Error(res.statusCode + " - " + res.statusMessage));
            } else {
                deferred.resolve(res);
            }
        });

        req.on("error", function(err) {
            deferred.reject(err);
        });

        if (!data) {
            req.end();
        } else {
            switch (typeof data) {
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

    /**
     * @param {String} method
     * @param {URL} reqParams
     * @param {Object} data
     * @return {Promise}
     * @private
     */
    function httpsReq(method, reqParams, data) {
        var deferred = Q.defer();
        var req = https.request(extend({method: method, port: 443}, reqParams), function(res) {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                deferred.reject(res);
            } else {
                deferred.resolve(res);
            }
        });

        req.on("error", function(err) {
            deferred.reject(err);
        });

        if (!data) {
            req.end();
        } else {
            switch (typeof data) {
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


    Qed = {
        logger: console,
        Q: Q,
        httpGET: function(reqParams) {
            return httpReq("GET", reqParams);
        },
        httpPOST: function(reqParams, data) {
            return httpReq("POST", reqParams, data);
        },
        httpsHEAD: function(reqParams) {
            return httpsReq("HEAD", reqParams);
        },
        httpsGET: function(reqParams) {
            return httpsReq("GET", reqParams);
        },
        httpsPOST: function(reqParams, data) {
            return httpsReq("POST", reqParams, data);
        },
        httpsPUT: function(reqParams, data) {
            return httpsReq("PUT", reqParams, data);
        },
        httpResponseHandler: {
            simpleData: function(res) {
                var data = "", deferred = Q.defer();
                res.on('data', function(chunk) {
                    data += chunk;
                });
                res.on('end', function() {
                    deferred.resolve(data);
                });
                return deferred.promise;
            },
            buffer: function(res) {
                var buffers = [], deferred = Q.defer();
                res.on('data', function(chunk) {
                    buffers.push(chunk);
                });
                res.on('end', function() {
                    deferred.resolve(Buffer.concat(buffers));
                });
                return deferred.promise;
            },
            json: function(res) {
                return Qed.httpResponseHandler.simpleData(res).then(function(data) {
                    return JSON.parse(data);
                });
            },
            xml: function(res) {
                return Qed.httpResponseHandler.simpleData(res).then(Qed.parseXml);
            },
            headers: function(res) {
                return res.headers;
            },
            hls: function(mode, baseUrl) {
                return function(res) {
                    return Qed.httpResponseHandler.m3u8(res).then(function(m3u) {
                        m3u.items.StreamItem.sort(function(a, b) {
                            return parseInt(a.attributes.attributes.bandwidth) - parseInt(b.attributes.attributes.bandwidth);
                        });
                        var selectedStreams;
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

                        return selectedStreams.reduce(function(chain, stream) {
                            return chain.then(function() {
                                return url.parse(stream.properties.uri);
                            }).then(function(streamUrl) {
                                return Qed.httpGET({
                                    hostname: streamUrl.hostname || (baseUrl && baseUrl.hostname),
                                    path: (baseUrl && baseUrl.path || "") + streamUrl.path
                                });
                            }).then(Qed.httpResponseHandler.m3u8).then(function(m3u) {
                                stream.content = m3u;
                                return stream;
                            });
                        }, Q()).thenResolve(selectedStreams);

                    });
                }
            },
            pipeToFile: function(path) {
                return function(res) {
                    var deferred = Q.defer();

                    var tsFile = fs.createWriteStream(path);

                    tsFile.on("finish", function() {
                        tsFile.close();
                        deferred.resolve(path);
                    });

                    tsFile.on("error", function(error) {
                        deferred.reject("Couldn't write " + path + ":" + error);
                    });

                    if (res.statusCode !== 200) {
                        tsFile.close();
                        res.socket.end();
                        deferred.reject("Couldn't get file '" + path + "' statusCode  : " + res.statusCode);

                    } else {
                        res.pipe(tsFile);
                    }

                    return deferred.promise;
                }
            }
        },
        md5sum: function(filepath) {
            var deferred = Q.defer();
            var stream = fs.ReadStream(filepath);
            var md5 = Crypto.createHash("md5");

            stream.on("data", function(data) {
                md5.update(data);
            });
            stream.on("end", function() {
                deferred.resolve(md5.digest("hex"));
            });

            return deferred.promise;
        },
        allLimit: function(tasks, limit) {
            var queues = [];
            var results = [];

            for (var i = 0; i < tasks.length; i++) {
                if (!queues[i % limit]) {
                    queues[i % limit] = [];
                }
                queues[i % limit].push(tasks[i]);
            }

            return Q.allSettled(queues.map(function(queue, queueIndex) {
                return queue.reduce(function(chain, task, i) {
                    return chain.then(task).then(function(result) {
                        results[i * limit + queueIndex] = result;
                    });
                }, Q());
            })).thenResolve(results);
        },
        downloadFiles: function(urls, filenames, targetFolder, maxParallelDownloads) {
            if (!filenames) {
                filenames = [];
            }
            var queues = [];

            for (var i = 0; i < urls.length; i++) {
                if (!queues[i % maxParallelDownloads]) {
                    queues[i % maxParallelDownloads] = [];
                }
                queues[i % maxParallelDownloads].push({url: urls[i], filename: filenames[i], index: i});
            }
            return Q.allSettled(queues.map(function(queue) {
                return queue.reduce(function(chain, item) {
                    return chain.then(function() {
                        return Qed.downloadFile(item.url, item.filename, targetFolder);
                    }).then(function(filename) {
                        item.filename = filename;
                    }).catch(function(err) {
                        item.error = err;
                    });
                }, Q());
            })).then(function() {
                return queues.reduce(function(array, queue) {
                    return array.concat(queue);
                }, []).sort(function(a, b) {
                    return a.index - b.index;
                });
            });
        },
        downloadFile: function(url, filename, targetFolder) {
            if (!filename) {
                filename = url.pathname.split("/").pop();
            }
            if (targetFolder) {
                filename = targetFolder + path.sep + filename;
            }

            return Qed.tryPromise(Qed.httpGET, [{
                hostname: url.host,
                path: url.path
            }], 10).then(Qed.httpResponseHandler.pipeToFile(filename));
        },
        fs: {
            mkdir: Q.denodeify(fs.mkdir),
            unlink: Q.denodeify(fs.unlink),
            rmdir: Q.denodeify(fs.rmdir),
            readdir: Q.denodeify(fs.readdir),
            open: Q.denodeify(fs.open),
            write: Q.denodeify(fs.write),
            writeFile: Q.denodeify(fs.writeFile),
            readFile: Q.denodeify(fs.readFile),
            close: Q.denodeify(fs.close),
            stat: Q.denodeify(fs.stat),
            chmod: Q.denodeify(fs.chmod),
            removeDirAndContents: function(dir) {
                return Qed.fs.readdir(dir).then(function(files) {
                    return Q.all(files.map(function(file) {
                        return Qed.fs.unlink(dir + path.sep + file);
                    }));
                }).then(function() {
                    return Qed.fs.rmdir(dir);
                });
            }
        },
        tryPromise: function(f, args, maxTries, delay) {
            return Q.fapply(f, args).catch(function(err) {
                debug("Error occurred", err);
                if (maxTries || maxTries === 0) {
                    debug("Left attempts : " + maxTries);
                } else {
                    debug("Retrying...");
                }
                if (maxTries || typeof maxTries !== "number") {
                    return Q.delay(null, delay || 0).then(function() {
                        return Qed.tryPromise(f, args, maxTries ? maxTries - 1 : null, delay);
                    });
                } else {
                    return Promise.reject(err);
                }
            });
        },
        yql: function(query) {
            var queryUrl = url.parse("https://query.yahooapis.com/v1/public/yql?q=" + encodeURIComponent(query) + "&format=json&callback=");
            return Qed.httpsGET(queryUrl).then(Qed.httpResponseHandler.json, function(res) {
                throw new Error(res.statusCode + " - " + res.statusMessage);
            });
        }
    };

    try {
        var prompt = require("prompt");
        Qed.prompt = function(fields) {
            prompt.start();
            var deferred = Q.defer();
            prompt.get(fields, function(err, results) {
                if (err) {
                    deferred.reject(err);
                } else {
                    deferred.resolve(results);
                }
            });
            return deferred.promise;
        }
    } catch (e) {
        Qed.prompt = function() {
            throw new Error("Missing peer dependency 'prompt'");
        }
    }

    try {
        var m3u8 = require("m3u8");
        Qed.httpResponseHandler.m3u8 = function(res) {
            var deferred = Q.defer();
            if (res.statusCode !== 200) {
                deferred.reject("Couldn't get m3u8 playlist : " + res.statusCode);
            } else {
                var parser = m3u8.createStream();
                res.pipe(parser);

                parser.on("m3u", function(m3u) {
                    deferred.resolve(m3u);
                });
            }
            return deferred.promise;
        }
    } catch (e) {
        Qed.httpResponseHandler.prompt = function() {
            throw new Error("Missing peer dependency 'm3u8'");
        }
    }

    try {
        var xml2js = require("xml2js").Parser({
            normalizeTags: true,
            explicitArray: false,
            trim: true,
            normalize: true
        });
        Qed.parseXml = function(string) {
            var deferred = Q.defer();
            xml2js.parseString(string, function(err, result) {
                if (err) {
                    deferred.reject(err);
                } else {
                    deferred.resolve(result);
                }
            });
            return deferred.promise;
        };
    } catch (e) {
        Qed.prompt = function() {
            throw new Error("Missing peer dependency 'xml2js'");
        }
    }

    return Qed;

})();