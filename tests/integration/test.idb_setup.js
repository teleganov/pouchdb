'use strict';

var META_STORE = 'meta-store';
var DOC_STORE = 'document-store';
var DETECT_BLOB_SUPPORT_STORE = 'detect-blob-support';

function sortedStoreNames(storeNames) {
  if (typeof storeNames === 'string') {
    return [storeNames];
  }
  return Array.prototype.slice.call(storeNames).sort();
}

function loadPouchDB(iframe) {
  return new Promise(function (resolve, reject) {
    var script = iframe.contentDocument.createElement('script');
    script.src = new URL(testUtils.pouchdbSrc(), window.location.href).href;
    script.onload = resolve;
    script.onerror = reject;
    iframe.contentDocument.body.appendChild(script);
  });
}

function deleteDatabase(name) {
  return new Promise(function (resolve, reject) {
    var request = indexedDB.deleteDatabase(name);
    request.onsuccess = resolve;
    request.onerror = function () {
      reject(request.error);
    };
    request.onblocked = function () {
      reject(new Error('Database cleanup was blocked for ' + name));
    };
  });
}

describe('idb setup', function () {
  var iframe;
  var FramePouchDB;
  var databaseNames;
  var indexedDBNames;
  var databaseConnections;
  var transactionDescriptor;

  before(function () {
    if (PouchDB.preferredAdapters[0] !== 'idb') {
      this.skip();
    }
  });

  beforeEach(function () {
    var suffix = Date.now() + '_' + Math.random().toString().slice(2);
    databaseNames = [
      'idb_setup_first_' + suffix,
      'idb_setup_second_' + suffix
    ];
    indexedDBNames = databaseNames.map(function (name) {
      return '_pouch_' + name;
    });
    databaseConnections = [];

    return new Promise(function (resolve, reject) {
      iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      iframe.onload = resolve;
      iframe.onerror = reject;
      iframe.src = 'about:blank';
      document.body.appendChild(iframe);
    }).then(function () {
      return loadPouchDB(iframe);
    }).then(function () {
      FramePouchDB = iframe.contentWindow.PouchDB;
      FramePouchDB.preferredAdapters = ['idb'];
    });
  });

  afterEach(function () {
    if (transactionDescriptor) {
      Object.defineProperty(iframe.contentWindow.IDBDatabase.prototype,
        'transaction', transactionDescriptor);
    }
    databaseConnections.forEach(function (connection) {
      connection.close();
    });
    if (iframe) {
      document.body.removeChild(iframe);
    }

    transactionDescriptor = null;
    return Promise.all(indexedDBNames.map(deleteDatabase));
  });

  it('completes setup when Blob detection fails asynchronously', function () {
    // Arrange
    var metadataTransactions = [];
    var metadataCompleted = {};
    var detectionTransactions = [];
    var detectionStartedAfterMetadata;
    var prototype = iframe.contentWindow.IDBDatabase.prototype;
    transactionDescriptor = Object.getOwnPropertyDescriptor(
      prototype, 'transaction');
    var originalTransaction = transactionDescriptor.value;

    Object.defineProperty(prototype, 'transaction', {
      configurable: transactionDescriptor.configurable,
      enumerable: transactionDescriptor.enumerable,
      writable: transactionDescriptor.writable,
      value: function (storeNames) {
        var names = sortedStoreNames(storeNames);
        var transaction = originalTransaction.apply(this, arguments);

        if (indexedDBNames.indexOf(this.name) === -1) {
          return transaction;
        }
        if (databaseConnections.indexOf(this) === -1) {
          databaseConnections.push(this);
        }

        if (names.indexOf(META_STORE) !== -1 &&
            names.indexOf(DOC_STORE) !== -1) {
          metadataTransactions.push(names);
          transaction.addEventListener('complete', function () {
            metadataCompleted[this.db.name] = true;
          });
        }

        if (names.indexOf(DETECT_BLOB_SUPPORT_STORE) !== -1) {
          detectionTransactions.push(names);
          detectionStartedAfterMetadata = metadataCompleted[this.name] === true;
          iframe.contentWindow.Promise.resolve().then(function () {
            transaction.abort();
          });
        }

        return transaction;
      }
    });

    // Act
    var first = new FramePouchDB(databaseNames[0], {adapter: 'idb'});
    return first.info().then(function (firstInfo) {
      var second = new FramePouchDB(databaseNames[1], {adapter: 'idb'});
      return second.info().then(function (secondInfo) {
        return {firstInfo, secondInfo};
      });
    }).then(function (infos) {
      // Assert
      metadataTransactions.should.have.length(2);
      metadataTransactions.forEach(function (stores) {
        stores.should.deep.equal([DOC_STORE, META_STORE]);
        stores.should.not.include(DETECT_BLOB_SUPPORT_STORE);
      });
      detectionTransactions.should.deep.equal([[DETECT_BLOB_SUPPORT_STORE]]);
      detectionStartedAfterMetadata.should.equal(true);
      infos.firstInfo.adapter.should.equal('idb');
      infos.firstInfo.doc_count.should.equal(0);
      infos.firstInfo.idb_attachment_format.should.equal('base64');
      infos.secondInfo.adapter.should.equal('idb');
      infos.secondInfo.idb_attachment_format.should.equal('base64');
    });
  });
});
