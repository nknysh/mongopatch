var mongojs = require('mongojs');
var stream = require('stream-wrapper');
var semver = require('semver');

var streams = require('./streams');
var log = require('./log');

var packageJson = require('../package.json');

var TMP_COLLECTION = '_patch_tmp';

var create = function(patch, options) {
	var applicationDb = mongojs(options.db);
	var logDb = options.logDb && mongojs(options.logDb);

	var that = stream.passThrough({ objectMode: true });

	that.db = applicationDb;
	that.id = null;

	that.update = function(collection, query, worker) {
		if(!worker) {
			worker = query;
			query = null;
		}

		that.id = 'patch_' + Date.now() + '_' + collection;
		that._update = {
			collection: collection,
			query: query,
			worker: worker
		};
	};
	that.after = function(callback) {
		that._after = callback;
	};
	that.version = function(version) {
		that._version = version;
	};

	var update = function() {
		var collection = that._update.collection;
		var query = that._update.query;
		var worker = that._update.worker;

		var afterCallback = that._after;
		var logCollection = that.id;

		var stream = streams.patch(applicationDb.collection(collection), worker, { concurrency: options.parallel, query: query });
		var streamsFactory = logDb ? streams.logged(logDb.collection(logCollection)) : streams;

		if(options.dryRun) {
			stream = stream.pipe(streamsFactory.tmp(applicationDb.collection(TMP_COLLECTION), { afterCallback: afterCallback, concurrency: options.parallel }));
		} else {
			stream = stream.pipe(streamsFactory.update({ afterCallback: afterCallback, concurrency: options.parallel }));
		}

		if(options.diff) {
			stream = stream.pipe(streamsFactory.diff({ concurrency: options.parallel }));
		}

		stream = stream
			.pipe(log(applicationDb.collection(collection), query, { db: logDb, collection: logCollection }))
			.pipe(that);

		stream.on('end', function() {
			applicationDb.close();
			logDb && logDb.close();
		});

		stream.resume();
	};

	patch(that);

	setImmediate(function() {
		if(!that._version || !semver.eq(that._version, packageJson.version)) {
			throw new Error('Specified version does not match current system version');
		}
		if(!that._update) {
			throw new Error('Update missing');
		}

		update();
	});

	return that;
};

module.exports = create;