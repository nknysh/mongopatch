var async = require('async');
var stream = require('stream-wrapper');
var parallel = require('parallel-transform');
var bson = new (require('bson').pure().BSON)();
var flat = require('flat');
var traverse = require('traverse');
var xtend = require('xtend');

var DEFAULT_CONCURRENCY = 1;

var diff = function(result, a, b, truncateArrays) {
	var all = Object.keys(a).concat(Object.keys(b)).reduce(function(res, k) {
		res[k] = true;
		return res;
	}, {});

	Object.keys(all).forEach(function(k) {
		if (String(a[k]) === String(b[k])) {
			return;
		}
		if (a[k] === null && b[k] === undefined) {
			return;
		}
		if (b[k] === null && a[k] === undefined) {
			return;
		}

		var resultK = truncateArrays ? k.replace(/\.\d+(\.|$)/, '.[*]$1') : k;
		var r = result[resultK];

		result[resultK] = r = r || { added: 0, removed: 0, updated: 0 };

		if(!(k in b)) {
			return r.removed++;
		}
		if(!(k in a)) {
			return r.added++;
		}

		r.updated++;
	});

	return result;
};

var noopCallback = function(doc, callback) {
	callback();
};

var loggedTransformStream = function(fn, logCollection, options) {
	options = xtend(options, {
		afterCallback: noopCallback,
		concurrency: DEFAULT_CONCURRENCY
	});

	var update = parallel(options.concurrency, function(patch, callback) {
		var document = patch.document;
		var id = document._id;

		var originalJsonDocument = JSON.stringify(document);

		var updatedDocument;
		var logDocument;

		async.waterfall([
			function(next) {
				logCollection.insert({
					_id: id,
					before: document,
					collection: patch.collection.toString(),
					query: JSON.stringify(patch.query),
					modified: false,
					createdAt: new Date()
				}, next);
			},
			function(result, next) {
				logDocument = result[0];
				fn(patch, next);
			},
			function(result, next) {
				updatedDocument = result;
				patch.updatedDocument = bson.deserialize(bson.serialize(updatedDocument));

				var modified = originalJsonDocument !== JSON.stringify(updatedDocument);

				logCollection.update(
					{ _id: logDocument._id },
					{ $set: { after: updatedDocument, modified: modified } },
					function(err) {
						next(err);
					}
				);
			},
			function(next) {
				options.afterCallback(updatedDocument, next);
			},
			function() {
				callback(null, patch);
			}
		], function(err) {
			if(err && logDocument) {
				var documentError = {
					message: err.message,
					stack: err.stack
				};

				logCollection.update(
					{ _id: logDocument._id },
					{ $set: { error: documentError } },
					function() {
						callback(err);
					}
				);

				return;
			}

			callback(err);
		});
	});

	return update;
};

var transformStream = function(fn, options) {
	options = xtend(options, {
		afterCallback: noopCallback,
		concurrency: DEFAULT_CONCURRENCY
	});

	return parallel(options.concurrency, function(patch, callback) {
		async.waterfall([
			function(next) {
				fn(patch, next);
			},
			function(updatedDocument, next) {
				patch.updatedDocument = bson.deserialize(bson.serialize(updatedDocument));
				options.afterCallback(updatedDocument, next);
			},
			function() {
				callback(null, patch);
			}
		], callback);
	});
};

var applyUpdate = function(patch, callback) {
	patch.collection.findAndModify({
		query: { _id: patch.document._id },
		'new': true,
		update: patch.update
	}, function(err, updatedDocument) {
		// Ensure arity
		callback(err, updatedDocument);
	});
};

var applyTmp = function(tmpCollection, patch, callback) {
	var id = patch.document._id;
	var updatedDocument;

	async.waterfall([
		function(next) {
			tmpCollection.save(patch.document, next);
		},
		function(savedDocument, _, next) {
			tmpCollection.findAndModify({
				query: { _id: id },
				'new': true,
				update: patch.update
			}, next);
		},
		function(result, _, next) {
			updatedDocument = result;
			tmpCollection.remove({ _id: id }, next);
		},
		function() {
			callback(null, updatedDocument);
		}
	], callback);
};

var patchStream = function(collection, worker, options) {
	options = xtend(options, {
		concurrency: DEFAULT_CONCURRENCY,
		query: {}
	});

	var patch = parallel(options.concurrency, function(document, callback) {
		var clone = bson.deserialize(bson.serialize(document));

		worker(document, function(err, update) {
			if (err) {
				return callback(err);
			}
			if(!update) {
				return callback();
			}

			callback(null, {update:update, document:clone, query:options.query, collection:collection});
		});
	});

	collection
		.find(options.query)
		.sort({ _id: 1 })
		.pipe(patch);

	return patch;
};

var updateStream = function(options) {
	return transformStream(applyUpdate, options);
};

var tmpStream = function(tmpCollection, options) {
	var fn = function(patch, callback) {
		applyTmp(tmpCollection, patch, callback);
	};

	return transformStream(fn, options);
};

var diffStream = function() {
	var acc = {};

	return stream.transform({ objectMode: true }, function(patch, encoding, callback) {
		var document = flat.flatten(patch.document);
		var updatedDocument = flat.flatten(patch.updatedDocument);

		patch.diff = diff(acc, document, updatedDocument, true);

		callback(null, patch);
	});
};

var loggedDiffStream = function(logCollection, options) {
	var acc = {};

	options = xtend(options, { concurrency: DEFAULT_CONCURRENCY });

	return parallel(options.concurrency, function(patch, callback) {
		var document = flat.flatten(patch.document);
		var updatedDocument = flat.flatten(patch.updatedDocument);

		patch.diff = diff(acc, document, updatedDocument, true);

		var documentDiff = diff({}, document, updatedDocument);

		Object.keys(documentDiff).forEach(function(key) {
			var d = documentDiff[key];
			documentDiff[key] = (d.added && 'added') || (d.removed && 'removed') || (d.updated && 'updated');
		});

		documentDiff = traverse(flat.unflatten(documentDiff)).map(function(obj) {
			if(!Array.isArray(obj)) {
				return;
			}

			this.update(obj.filter(function(value) {
				return value !== undefined;
			}));
		});

		logCollection.update({ _id: patch.document._id }, { $set: { diff: documentDiff } }, function(err) {
			callback(err, patch);
		});
	});
};

var loggedUpdateStream = function(logCollection, options) {
	return loggedTransformStream(applyUpdate, logCollection, options);
};

var loggedTmpStream = function(logCollection, tmpCollection, options) {
	var fn = function(patch, callback) {
		applyTmp(tmpCollection, patch, callback);
	};

	return loggedTransformStream(fn, logCollection, options);
};

var normalize = function(fn, logCollection) {
	return function() {
		var args = Array.prototype.slice.call(arguments);
		args.unshift(logCollection);

		return fn.apply(null, args);
	};
};

var logged = exports.logged = function(logCollection) {
	var that = {};

	that.update = normalize(logged.update, logCollection);
	that.tmp = normalize(logged.tmp, logCollection);
	that.diff = normalize(logged.diff, logCollection);

	return that;
};

exports.patch = patchStream;
exports.update = updateStream;
exports.tmp = tmpStream;
exports.diff = diffStream;

exports.logged.update = loggedUpdateStream;
exports.logged.tmp = loggedTmpStream;
exports.logged.diff = loggedDiffStream;