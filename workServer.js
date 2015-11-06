var redis = require('./redis');
var queue = require('./queue');
var utility = require('./utility');
var config = require('./config');
var getReplayUrl = require('./getReplayUrl');
var moment = require('moment');
var db = require('./db');
var insertMatch = require('./queries').insertMatch;
var buildSets = require('./buildSets');
var bodyParser = require('body-parser');
var express = require('express');
var EventEmitter = require('events');
var app = express();
var port = config.PORT || config.WORK_PORT;
var active_jobs = {};
buildSets(db, redis, function(err) {
    if (err) {
        throw err;
    }
    queue.parse.getActive().then(function(actives) {
        console.log('clearing actives');
        //requeue currently active jobs
        actives.forEach(function(job) {
            job.moveToFailed("shutdown");
        });
        return;
    }).then(start);
});

function start() {
    app.use(bodyParser.json({
        limit: '1mb'
    }));
    app.get('/parse', function(req, res) {
        if (config.RETRIEVER_SECRET && req.query.key !== config.RETRIEVER_SECRET) {
            return res.status(500).json({
                error: "invalid key"
            });
        }
        console.log('client requested work');
        queue.parse.getNextJob().then(function(job) {
            job.ee = new EventEmitter();
            active_jobs[job.jobId] = job;
            var expire = setTimeout(function() {
                console.log('job %s expired', job.jobId);
                return cb("timeout");
            }, 180 * 1000);
            console.log('server assigned jobid %s', job.jobId);
            var match_id = job.data.payload.match_id;
            var match = job.data.payload;
            //TODO non-valve urls don't expire, we can try using them
            if (match.start_time < moment().subtract(7, 'days').format('X') && !(match.leagueid > 0)) {
                console.log("replay too old, url expired");
                return cb();
            }
            //get the replay url and save it
            getReplayUrl(db, redis, match, function(err) {
                if (err) {
                    return cb(err);
                }
                else {
                    console.time("parse " + match_id);
                    console.log('server sent jobid %s', job.jobId);
                    res.json({
                        jobId: job.jobId,
                        data: job.data
                    });
                    job.ee.on('submitwork', function(parsed_data) {
                        if (parsed_data.error) {
                            return cb(parsed_data.error);
                        }
                        delete parsed_data.key;
                        delete parsed_data.jobId;
                        //extend match object with parsed data, keep existing data if key conflict (match_id)
                        //match.players was deleted earlier during insertion of api data
                        for (var key in parsed_data) {
                            match[key] = match[key] || parsed_data[key];
                        }
                        match.players.forEach(function(p, i) {
                            p.player_slot = i < match.players.length / 2 ? i : i + (128 - 5);
                        });
                        match.parse_status = 2;
                        //fs.writeFileSync("output.json", JSON.stringify(match));
                        insertMatch(db, redis, queue, match, {
                            type: "parsed"
                        }, function(err) {
                            console.timeEnd("parse " + match_id);
                            clearTimeout(expire);
                            cb(err);
                        });
                    });
                }
            });

            function cb(err) {
                delete active_jobs[job.jobId];
                if (err) {
                    return job.moveToFailed(err);
                }
                return job.moveToCompleted();
            }
        }).catch(function(err) {
            err = err || "no work available";
            return res.json({
                error: err
            });
        });
    });
    app.post('/parse', function(req, res) {
        //validate request
        if (config.RETRIEVER_SECRET && req.body.key !== config.RETRIEVER_SECRET) {
            return res.status(500).json({
                error: "invalid key"
            });
        }
        //got data from worker, signal the job with this match_id
        console.log('received submitted work');
        if (active_jobs[req.body.jobId]) {
            var job = active_jobs[req.body.jobId];
            job.ee.emit('submitwork', req.body);
            return res.json({
                error: null
            });
        }
        else {
            return res.json({
                error: "no active job with this jobid"
            });
        }
    });
    var server = app.listen(port, function() {
        var host = server.address().address;
        console.log('[WORKSERVER] listening at http://%s:%s', host, port);
    });
}
