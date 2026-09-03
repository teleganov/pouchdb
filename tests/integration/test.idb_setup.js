'use strict';

var META_STORE = 'meta-store';
var DOC_STORE = 'document-store';
var BY_SEQ_STORE = 'by-sequence';
var DETECT_BLOB_SUPPORT_STORE = 'detect-blob-support';
var METADATA_STORES = [DOC_STORE, META_STORE];
var DETECTION_STORES = [DETECT_BLOB_SUPPORT_STORE];
var INFO_STORES = [BY_SEQ_STORE, META_STORE];

function sortedStoreNames(storeNames) {
  if (typeof storeNames === 'string') {
    return [storeNames];
  }
  return Array.prototype.slice.call(storeNames).sort();
}

function sameStores(call, expectedStores) {
  return call.stores.join(',') === expectedStores.join(',');
}

function callsForStores(tracker, expectedStores) {
  return tracker.calls.filter(function (call) {
    return sameStores(call, expectedStores);
  });
}

function loadScript(targetDocument, source) {
  return new Promise(function (resolve, reject) {
    var script = targetDocument.createElement('script');
    script.async = true;
    script.src = new URL(source, window.location.href).href;
    script.onload = resolve;
    script.onerror = reject;
    targetDocument.body.appendChild(script);
  });
}

function createTestFrame() {
  return new Promise(function (resolve, reject) {
    var iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.onload = function () {
      resolve(iframe);
    };
    iframe.onerror = reject;
    iframe.src = 'about:blank';
    document.body.appendChild(iframe);
  });
}

function deleteDatabase(name) {
  return new Promise(function (resolve, reject) {
    var request = window.indexedDB.deleteDatabase(name);
    request.onsuccess = resolve;
    request.onerror = function () {
      reject(request.error);
    };
    request.onblocked = function () {
      reject(new Error('Database cleanup was blocked for ' + name));
    };
  });
}

function rejectionWithin(promise, delay) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      reject(new Error('Expected operation to reject within ' + delay + 'ms'));
    }, delay);

    promise.then(function () {
      clearTimeout(timer);
      reject(new Error('Expected operation to reject'));
    }, function (error) {
      clearTimeout(timer);
      resolve(error);
    });
  });
}

function instrumentTransactions(frameWindow, indexedDBNames, hooks) {
  hooks = hooks || {};

  var calls = [];
  var connections = [];
  var sequence = 0;
  var prototype = frameWindow.IDBDatabase.prototype;
  var descriptor = Object.getOwnPropertyDescriptor(prototype, 'transaction');
  var originalTransaction = descriptor.value;

  function transaction(storeNames, mode) {
    if (indexedDBNames.indexOf(this.name) === -1) {
      return originalTransaction.apply(this, arguments);
    }

    if (connections.indexOf(this) === -1) {
      connections.push(this);
    }

    var call = {
      databaseName: this.name,
      stores: sortedStoreNames(storeNames),
      mode,
      startedAt: sequence++,
      opened: false,
      completed: false,
      aborted: false,
      injected: false,
    };
    calls.push(call);

    if (hooks.beforeOpen) {
      hooks.beforeOpen(call);
    }

    var txn = originalTransaction.apply(this, arguments);
    call.opened = true;
    call.transaction = txn;

    txn.addEventListener('complete', function () {
      call.completed = true;
      call.completedAt = sequence++;
    });
    txn.addEventListener('abort', function () {
      call.aborted = true;
      call.abortedAt = sequence++;
    });

    if (hooks.afterOpen) {
      hooks.afterOpen(call);
    }

    return txn;
  }

  Object.defineProperty(prototype, 'transaction', {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    value: transaction,
    writable: descriptor.writable,
  });

  return {
    calls,
    connections,
    restore: function () {
      Object.defineProperty(prototype, 'transaction', descriptor);
    },
  };
}

describe('idb setup', function () {
  var iframe;
  var FramePouchDB;
  var instrumentation;
  var indexedDBNames;

  before(function () {
    if (PouchDB.preferredAdapters[0] !== 'idb') {
      this.skip();
    }
  });

  beforeEach(function () {
    indexedDBNames = [];
    return createTestFrame().then(function (testFrame) {
      iframe = testFrame;
      return loadScript(iframe.contentDocument, testUtils.pouchdbSrc());
    }).then(function () {
      FramePouchDB = iframe.contentWindow.PouchDB;
      FramePouchDB.preferredAdapters = ['idb'];
    });
  });

  afterEach(function () {
    var cleanupErrors = [];

    if (instrumentation) {
      try {
        instrumentation.restore();
      } catch (error) {
        cleanupErrors.push(error);
      }
      instrumentation.connections.forEach(function (connection) {
        try {
          connection.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
      });
    }

    if (iframe) {
      try {
        document.body.removeChild(iframe);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    var cleanup = Promise.all(indexedDBNames.map(function (name) {
      return deleteDatabase(name).catch(function (error) {
        cleanupErrors.push(error);
      });
    }));
    iframe = null;
    FramePouchDB = null;
    instrumentation = null;
    indexedDBNames = [];
    return cleanup.then(function () {
      if (cleanupErrors.length) {
        throw cleanupErrors[0];
      }
    });
  });

  function databaseNames(label) {
    var suffix = Date.now() + '_' + Math.random().toString().slice(2);
    var names = [
      'idb_setup_' + label + '_first_' + suffix,
      'idb_setup_' + label + '_second_' + suffix,
    ];
    indexedDBNames = names.map(function (name) {
      return '_pouch_' + name;
    });
    return names;
  }

  function setupInstrumentation(names, hooks) {
    instrumentation = instrumentTransactions(iframe.contentWindow, names, hooks);
    return instrumentation;
  }

  function openDatabases(names) {
    var first = new FramePouchDB(names[0]);
    return first.info().then(function (firstInfo) {
      var second = new FramePouchDB(names[1]);
      return second.info().then(function (secondInfo) {
        return [firstInfo, secondInfo];
      });
    });
  }

  it('isolates and caches Blob detection', function () {
    // Arrange
    var names = databaseNames('isolation');
    var tracker = setupInstrumentation(indexedDBNames);

    // Act
    return openDatabases(names).then(function (infos) {
      var calls = tracker.calls;
      var metadataCalls = callsForStores(tracker, METADATA_STORES);
      var detectionCalls = callsForStores(tracker, DETECTION_STORES);
      var infoCalls = callsForStores(tracker, INFO_STORES);

      // Assert
      calls.should.have.length(5);
      calls.map(function (call) {
        return call.databaseName;
      }).should.deep.equal([
        indexedDBNames[0], indexedDBNames[0], indexedDBNames[0],
        indexedDBNames[1], indexedDBNames[1],
      ]);
      metadataCalls.should.have.length(2);
      metadataCalls.forEach(function (call) {
        call.stores.should.deep.equal(METADATA_STORES);
        call.stores.should.not.include(DETECT_BLOB_SUPPORT_STORE);
        call.mode.should.equal('readwrite');
        call.opened.should.equal(true);
        call.completed.should.equal(true);
        call.aborted.should.equal(false);
      });
      detectionCalls.should.have.length(1);
      detectionCalls[0].databaseName.should.equal(indexedDBNames[0]);
      detectionCalls[0].stores.should.deep.equal(DETECTION_STORES);
      detectionCalls[0].stores.should.not.include(META_STORE);
      detectionCalls[0].stores.should.not.include(DOC_STORE);
      detectionCalls[0].mode.should.equal('readwrite');
      detectionCalls[0].opened.should.equal(true);
      detectionCalls[0].aborted.should.equal(false);
      metadataCalls[0].completedAt.should.be.below(detectionCalls[0].startedAt);
      infoCalls.should.have.length(2);
      infoCalls.forEach(function (call) {
        call.stores.should.deep.equal(INFO_STORES);
        call.mode.should.equal('readonly');
        call.opened.should.equal(true);
        call.completed.should.equal(true);
        call.aborted.should.equal(false);
      });

      ['binary', 'base64'].should.include(infos[0].idb_attachment_format);
      infos[1].idb_attachment_format.should.equal(infos[0].idb_attachment_format);
      infos[0].adapter.should.equal('idb');
      infos[1].adapter.should.equal('idb');
    });
  });

  it('retries Blob detection after transaction creation fails', function () {
    // Arrange
    var names = databaseNames('creation_failure');
    var injectedError = new iframe.contentWindow.Error('injected detection failure');
    var injectionCount = 0;
    var tracker = setupInstrumentation(indexedDBNames, {
      beforeOpen: function (call) {
        if (sameStores(call, DETECTION_STORES) && injectionCount === 0) {
          call.injected = true;
          injectionCount++;
          throw injectedError;
        }
      },
    });

    // Act
    var first = new FramePouchDB(names[0]);
    return rejectionWithin(first.info(), 2000).then(function (error) {
      var second = new FramePouchDB(names[1]);
      return second.info().then(function (secondInfo) {
        return {error, secondInfo};
      });
    }).then(function (result) {
      var metadataCalls = callsForStores(tracker, METADATA_STORES);
      var detectionCalls = callsForStores(tracker, DETECTION_STORES);
      var infoCalls = callsForStores(tracker, INFO_STORES);

      // Assert
      assert.strictEqual(result.error, injectedError);
      injectionCount.should.equal(1);
      tracker.calls.should.have.length(5);
      metadataCalls.should.have.length(2);
      metadataCalls.forEach(function (call) {
        call.injected.should.equal(false);
        call.opened.should.equal(true);
        call.completed.should.equal(true);
        call.aborted.should.equal(false);
      });
      detectionCalls.should.have.length(2);
      detectionCalls[0].databaseName.should.equal(indexedDBNames[0]);
      detectionCalls[0].injected.should.equal(true);
      detectionCalls[0].opened.should.equal(false);
      detectionCalls[1].databaseName.should.equal(indexedDBNames[1]);
      detectionCalls[1].injected.should.equal(false);
      detectionCalls[1].opened.should.equal(true);
      detectionCalls[1].aborted.should.equal(false);
      infoCalls.should.have.length(1);
      infoCalls[0].databaseName.should.equal(indexedDBNames[1]);
      infoCalls[0].injected.should.equal(false);
      infoCalls[0].opened.should.equal(true);
      infoCalls[0].completed.should.equal(true);
      infoCalls[0].aborted.should.equal(false);
      ['binary', 'base64'].should.include(result.secondInfo.idb_attachment_format);
      result.secondInfo.adapter.should.equal('idb');
    });
  });

  it('uses base64 and caches the result when Blob detection aborts', function () {
    // Arrange
    var names = databaseNames('abort');
    var abortInjectionCount = 0;
    var tracker = setupInstrumentation(indexedDBNames, {
      afterOpen: function (call) {
        if (!sameStores(call, DETECTION_STORES) || abortInjectionCount !== 0) {
          return;
        }
        abortInjectionCount++;
        call.abortScheduled = true;
        iframe.contentWindow.Promise.resolve().then(function () {
          call.abortHandlerInstalled = typeof call.transaction.onabort === 'function';
          try {
            call.transaction.abort();
            call.abortCalled = true;
          } catch (error) {
            call.abortError = error;
          }
        });
      },
    });

    // Act
    return openDatabases(names).then(function (infos) {
      var metadataCalls = callsForStores(tracker, METADATA_STORES);
      var detectionCalls = callsForStores(tracker, DETECTION_STORES);
      var infoCalls = callsForStores(tracker, INFO_STORES);

      // Assert
      abortInjectionCount.should.equal(1);
      tracker.calls.should.have.length(5);
      metadataCalls.should.have.length(2);
      metadataCalls.forEach(function (call) {
        should.not.exist(call.abortScheduled);
        call.aborted.should.equal(false);
        call.completed.should.equal(true);
      });
      detectionCalls.should.have.length(1);
      detectionCalls[0].databaseName.should.equal(indexedDBNames[0]);
      detectionCalls[0].abortScheduled.should.equal(true);
      detectionCalls[0].abortHandlerInstalled.should.equal(true);
      detectionCalls[0].abortCalled.should.equal(true);
      detectionCalls[0].should.not.have.property('abortError');
      detectionCalls[0].aborted.should.equal(true);
      infoCalls.should.have.length(2);
      infoCalls.forEach(function (call) {
        should.not.exist(call.abortScheduled);
        call.aborted.should.equal(false);
        call.completed.should.equal(true);
      });
      infos[0].idb_attachment_format.should.equal('base64');
      infos[1].idb_attachment_format.should.equal('base64');
      infos[0].adapter.should.equal('idb');
      infos[1].adapter.should.equal('idb');
    });
  });
});
