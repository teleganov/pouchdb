'use strict';

const POUCHDB_SOURCE = '../../packages/node_modules/pouchdb/dist/pouchdb.js';
const ATTACHMENT_NAME = 'worker-diagnostic.txt';
const ATTACHMENT_DOCUMENT_ID = 'worker-attachment-document';
let operationTimeout = 6000;

function postLog(message, level) {
  self.postMessage({
    type: 'log',
    message,
    level: level || '',
  });
}

function errorDetails(error) {
  if (!error) {
    return 'no error object';
  }
  return `${error.name || 'Error'}: ${error.message || String(error)}`;
}

function assertResult(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runWithTimeout(label, operation) {
  let settled = false;
  postLog(`[START] ${label}`);
  const operationPromise = Promise.resolve().then(operation);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      const error = new Error(`${label} timed out after ${operationTimeout} ms`);
      error.name = 'DiagnosticTimeoutError';
      postLog(`[TIMEOUT] ${error.message}`, 'fail');
      reject(error);
    }, operationTimeout);

    operationPromise.then(result => {
      if (settled) {
        postLog(`[LATE RESULT] ${label}`, 'warn');
        return;
      }
      settled = true;
      clearTimeout(timer);
      postLog(`[DONE] ${label}`, 'pass');
      resolve(result);
    }, error => {
      if (settled) {
        postLog(`[LATE ERROR] ${label}: ${errorDetails(error)}`, 'warn');
        return;
      }
      settled = true;
      clearTimeout(timer);
      postLog(`[FAILED] ${label}: ${errorDetails(error)}`, 'fail');
      reject(error);
    });
  });
}

function readBlobAsText(blob) {
  if (blob && typeof blob.text === 'function') {
    return blob.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.onload = () => resolve(reader.result);
    reader.readAsText(blob);
  });
}

async function destroyDatabase(databaseName) {
  await runWithTimeout('destroy worker database', () => {
    const database = new PouchDB(databaseName, {adapter: 'idb'});
    return database.destroy();
  });
}

async function runDiagnostic(databaseName) {
  const attachmentText = 'attachment round trip from a PouchDB worker';
  let database;
  let attachmentFormat;
  let attachmentVerified = false;

  try {
    database = new PouchDB(databaseName, {adapter: 'idb'});
    postLog(`idb constructor returned for ${databaseName}`);

    const info = await runWithTimeout('idb info()', () => database.info());
    attachmentFormat = info.idb_attachment_format;
    assertResult(attachmentFormat === 'binary' || attachmentFormat === 'base64',
      `unexpected attachment format ${attachmentFormat}`);
    postLog(`attachment format: ${attachmentFormat}`, 'pass');

    const putResult = await runWithTimeout('write attachment', () => database.putAttachment(
      ATTACHMENT_DOCUMENT_ID,
      ATTACHMENT_NAME,
      new Blob([attachmentText], {type: 'text/plain'}),
      'text/plain'
    ));
    assertResult(putResult.ok, 'attachment write did not succeed');

    await runWithTimeout('read and verify attachment', async () => {
      const attachment = await database.getAttachment(
        ATTACHMENT_DOCUMENT_ID,
        ATTACHMENT_NAME
      );
      const text = await readBlobAsText(attachment);
      assertResult(text === attachmentText,
        `attachment content mismatch: expected ${attachmentText}, received ${text}`);
      attachmentVerified = true;
    });

    await runWithTimeout('close worker database', () => database.close());
    database = null;
  } finally {
    if (database && !database._closed) {
      try {
        await runWithTimeout('close worker database during cleanup', () => database.close());
      } catch (error) {
        postLog(`close cleanup failed: ${errorDetails(error)}`, 'fail');
      }
    }
    try {
      await destroyDatabase(databaseName);
    } catch (error) {
      postLog(`destroy cleanup failed: ${errorDetails(error)}`, 'fail');
    }
  }

  self.postMessage({
    type: 'complete',
    attachmentFormat,
    attachmentVerified,
  });
}

self.addEventListener('error', event => {
  postLog(`UNHANDLED worker error: ${event.message}`, 'fail');
});

self.addEventListener('unhandledrejection', event => {
  postLog(`UNHANDLED worker rejection: ${errorDetails(event.reason)}`, 'fail');
});

self.addEventListener('message', event => {
  const message = event.data || {};
  if (message.type !== 'run') {
    self.postMessage({type: 'failed', error: `unknown message type: ${message.type}`});
    return;
  }

  operationTimeout = message.timeout || operationTimeout;
  try {
    importScripts(POUCHDB_SOURCE);
  } catch (error) {
    self.postMessage({
      type: 'failed',
      error: `could not load ${POUCHDB_SOURCE}: ${errorDetails(error)}`,
    });
    return;
  }

  runDiagnostic(message.databaseName).catch(error => {
    self.postMessage({type: 'failed', error: errorDetails(error)});
  });
});
