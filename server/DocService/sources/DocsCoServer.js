/*
 * (c) Copyright Ascensio System Limited 2010-2017. All rights reserved
 *
 * http://www.teamlab.com 
 *
 * Version: 4.2.10 (build:10)
 */


'use strict';

var sockjs = require('sockjs');
var _ = require('underscore');
var https = require('https');
var http = require('http');
var url = require('url');
const fs = require('fs');
var cron = require('cron');
var co = require('co');
const jwt = require('jsonwebtoken');
const jwa = require('jwa');
const ms = require('ms');
var storage = require('./../../Common/sources/storage-base');
var logger = require('./../../Common/sources/logger');
const constants = require('./../../Common/sources/constants');
var utils = require('./../../Common/sources/utils');
var commonDefines = require('./../../Common/sources/commondefines');
var statsDClient = require('./../../Common/sources/statsdclient');
var config = require('config').get('services.CoAuthoring');
var sqlBase = require('./baseConnector');
var canvasService = require('./canvasservice');
var converterService = require('./converterservice');
var taskResult = require('./taskresult');
var redis = require(config.get('redis.name'));
var pubsubRedis = require('./pubsubRedis');
var pubsubService = require('./' + config.get('pubsub.name'));
var queueService = require('./../../Common/sources/taskqueueRabbitMQ');
var cfgSpellcheckerUrl = config.get('server.editor_settings_spellchecker_url');
var cfgCallbackRequestTimeout = config.get('server.callbackRequestTimeout');
var cfgAscSaveTimeOutDelay = config.get('server.savetimeoutdelay');

var cfgPubSubMaxChanges = config.get('pubsub.maxChanges');

var cfgRedisPrefix = config.get('redis.prefix');
var cfgExpSaveLock = config.get('expire.saveLock');
var cfgExpPresence = config.get('expire.presence');
var cfgExpLocks = config.get('expire.locks');
var cfgExpChangeIndex = config.get('expire.changeindex');
var cfgExpLockDoc = config.get('expire.lockDoc');
var cfgExpMessage = config.get('expire.message');
var cfgExpLastSave = config.get('expire.lastsave');
var cfgExpForceSave = config.get('expire.forcesave');
var cfgExpSaved = config.get('expire.saved');
var cfgExpDocumentsCron = config.get('expire.documentsCron');
var cfgExpSessionIdle = ms(config.get('expire.sessionidle'));
var cfgExpSessionAbsolute = ms(config.get('expire.sessionabsolute'));
var cfgExpSessionCloseCommand = ms(config.get('expire.sessionclosecommand'));
var cfgSockjsUrl = config.get('server.sockjsUrl');
var cfgTokenEnableBrowser = config.get('token.enable.browser');
var cfgTokenEnableRequestInbox = config.get('token.enable.request.inbox');
var cfgTokenEnableRequestOutbox = config.get('token.enable.request.outbox');
var cfgTokenSessionAlgorithm = config.get('token.session.algorithm');
var cfgTokenSessionExpires = ms(config.get('token.session.expires'));
var cfgTokenInboxHeader = config.get('token.inbox.header');
var cfgTokenInboxPrefix = config.get('token.inbox.prefix');
var cfgSecretSession = config.get('secret.session');

var redisKeySaveLock = cfgRedisPrefix + constants.REDIS_KEY_SAVE_LOCK;
var redisKeyPresenceHash = cfgRedisPrefix + constants.REDIS_KEY_PRESENCE_HASH;
var redisKeyPresenceSet = cfgRedisPrefix + constants.REDIS_KEY_PRESENCE_SET;
var redisKeyLocks = cfgRedisPrefix + constants.REDIS_KEY_LOCKS;
var redisKeyChangeIndex = cfgRedisPrefix + constants.REDIS_KEY_CHANGES_INDEX;
var redisKeyLockDoc = cfgRedisPrefix + constants.REDIS_KEY_LOCK_DOCUMENT;
var redisKeyMessage = cfgRedisPrefix + constants.REDIS_KEY_MESSAGE;
var redisKeyDocuments = cfgRedisPrefix + constants.REDIS_KEY_DOCUMENTS;
var redisKeyLastSave = cfgRedisPrefix + constants.REDIS_KEY_LAST_SAVE;
var redisKeyForceSave = cfgRedisPrefix + constants.REDIS_KEY_FORCE_SAVE;
var redisKeySaved = cfgRedisPrefix + constants.REDIS_KEY_SAVED;

var EditorTypes = {
  document : 0,
  spreadsheet : 1,
  presentation : 2
};

var defaultHttpPort = 80, defaultHttpsPort = 443;	// Порты по умолчанию (для http и https)
var connections = []; // Активные соединения
var redisClient = pubsubRedis.getClientRedis();
var pubsub;
var queue;
var clientStatsD = statsDClient.getClient();
var licenseInfo = {type: constants.LICENSE_RESULT.Error, light: false, branding: false};
var shutdownFlag = false;

var asc_coAuthV = '3.0.9';				// Версия сервера совместного редактирования

function getIsShutdown() {
  return shutdownFlag;
}

function DocumentChanges(docId) {
  this.docId = docId;
  this.arrChanges = [];

  return this;
}
DocumentChanges.prototype.getLength = function() {
  return this.arrChanges.length;
};
DocumentChanges.prototype.push = function(change) {
  this.arrChanges.push(change);
};
DocumentChanges.prototype.splice = function(start, deleteCount) {
  this.arrChanges.splice(start, deleteCount);
};
DocumentChanges.prototype.slice = function(start, end) {
  return this.arrChanges.splice(start, end);
};
DocumentChanges.prototype.concat = function(item) {
  this.arrChanges = this.arrChanges.concat(item);
};

var c_oAscServerStatus = {
  NotFound: 0,
  Editing: 1,
  MustSave: 2,
  Corrupted: 3,
  Closed: 4,
  MailMerge: 5,
  MustSaveForce: 6,
  CorruptedForce: 7
};

var c_oAscChangeBase = {
  No: 0,
  Delete: 1,
  All: 2
};

var c_oAscLockTimeOutDelay = 500;	// Время ожидания для сохранения, когда зажата база данных

var c_oAscRecalcIndexTypes = {
  RecalcIndexAdd: 1,
  RecalcIndexRemove: 2
};
var c_oAscLockTypes = {
  kLockTypeNone: 1, // никто не залочил данный объект
  kLockTypeMine: 2, // данный объект залочен текущим пользователем
  kLockTypeOther: 3, // данный объект залочен другим(не текущим) пользователем
  kLockTypeOther2: 4, // данный объект залочен другим(не текущим) пользователем (обновления уже пришли)
  kLockTypeOther3: 5  // данный объект был залочен (обновления пришли) и снова стал залочен
};

var c_oAscLockTypeElem = {
  Range: 1,
  Object: 2,
  Sheet: 3
};
var c_oAscLockTypeElemSubType = {
  DeleteColumns: 1,
  InsertColumns: 2,
  DeleteRows: 3,
  InsertRows: 4,
  ChangeProperties: 5
};

var c_oAscLockTypeElemPresentation = {
  Object: 1,
  Slide: 2,
  Presentation: 3
};

function CRecalcIndexElement(recalcType, position, bIsSaveIndex) {
  if (!(this instanceof CRecalcIndexElement)) {
    return new CRecalcIndexElement(recalcType, position, bIsSaveIndex);
  }

  this._recalcType = recalcType;		// Тип изменений (удаление или добавление)
  this._position = position;			// Позиция, в которой произошли изменения
  this._count = 1;				// Считаем все изменения за простейшие
  this.m_bIsSaveIndex = !!bIsSaveIndex;	// Это индексы из изменений других пользователей (которые мы еще не применили)

  return this;
}

CRecalcIndexElement.prototype = {
  constructor: CRecalcIndexElement,
  getLockOther: function(position, type) {
    var inc = (c_oAscRecalcIndexTypes.RecalcIndexAdd === this._recalcType) ? +1 : -1;
    if (position === this._position && c_oAscRecalcIndexTypes.RecalcIndexRemove === this._recalcType &&
      true === this.m_bIsSaveIndex) {
      return null;
    } else if (position === this._position &&
      c_oAscRecalcIndexTypes.RecalcIndexRemove === this._recalcType &&
      c_oAscLockTypes.kLockTypeMine === type && false === this.m_bIsSaveIndex) {
      return null;
    } else if (position < this._position) {
      return position;
    }
    else {
      return (position + inc);
    }
  },
  getLockSaveOther: function(position, type) {
    if (this.m_bIsSaveIndex) {
      return position;
    }

    var inc = (c_oAscRecalcIndexTypes.RecalcIndexAdd === this._recalcType) ? +1 : -1;
    if (position === this._position && c_oAscRecalcIndexTypes.RecalcIndexRemove === this._recalcType &&
      true === this.m_bIsSaveIndex) {
      return null;
    } else if (position === this._position &&
      c_oAscRecalcIndexTypes.RecalcIndexRemove === this._recalcType &&
      c_oAscLockTypes.kLockTypeMine === type && false === this.m_bIsSaveIndex) {
      return null;
    } else if (position < this._position) {
      return position;
    }
    else {
      return (position + inc);
    }
  },
  getLockMe: function(position) {
    var inc = (c_oAscRecalcIndexTypes.RecalcIndexAdd === this._recalcType) ? -1 : +1;
    if (position < this._position) {
      return position;
    }
    else {
      return (position + inc);
    }
  },
  getLockMe2: function(position) {
    var inc = (c_oAscRecalcIndexTypes.RecalcIndexAdd === this._recalcType) ? -1 : +1;
    if (true !== this.m_bIsSaveIndex || position < this._position) {
      return position;
    }
    else {
      return (position + inc);
    }
  }
};

function CRecalcIndex() {
  if (!(this instanceof CRecalcIndex)) {
    return new CRecalcIndex();
  }

  this._arrElements = [];		// Массив CRecalcIndexElement

  return this;
}

CRecalcIndex.prototype = {
  constructor: CRecalcIndex,
  add: function(recalcType, position, count, bIsSaveIndex) {
    for (var i = 0; i < count; ++i)
      this._arrElements.push(new CRecalcIndexElement(recalcType, position, bIsSaveIndex));
  },
  clear: function() {
    this._arrElements.length = 0;
  },
  getLockOther: function(position, type) {
    var newPosition = position;
    var count = this._arrElements.length;
    for (var i = 0; i < count; ++i) {
      newPosition = this._arrElements[i].getLockOther(newPosition, type);
      if (null === newPosition) {
        break;
      }
    }

    return newPosition;
  },
  getLockSaveOther: function(position, type) {
    var newPosition = position;
    var count = this._arrElements.length;
    for (var i = 0; i < count; ++i) {
      newPosition = this._arrElements[i].getLockSaveOther(newPosition, type);
      if (null === newPosition) {
        break;
      }
    }

    return newPosition;
  },
  getLockMe: function(position) {
    var newPosition = position;
    var count = this._arrElements.length;
    for (var i = count - 1; i >= 0; --i) {
      newPosition = this._arrElements[i].getLockMe(newPosition);
      if (null === newPosition) {
        break;
      }
    }

    return newPosition;
  },
  getLockMe2: function(position) {
    var newPosition = position;
    var count = this._arrElements.length;
    for (var i = count - 1; i >= 0; --i) {
      newPosition = this._arrElements[i].getLockMe2(newPosition);
      if (null === newPosition) {
        break;
      }
    }

    return newPosition;
  }
};

function sendData(conn, data) {
  conn.write(JSON.stringify(data));
}
function sendDataWarning(conn, msg) {
  sendData(conn, {type: "warning", message: msg});
}
function sendDataMessage(conn, msg) {
  sendData(conn, {type: "message", messages: msg});
}
function sendDataCursor(conn, msg) {
  sendData(conn, {type: "cursor", messages: msg});
}
function sendDataMeta(conn, msg) {
  sendData(conn, {type: "meta", messages: msg});
}
function sendDataSession(conn, msg) {
  sendData(conn, {type: "session", messages: msg});
}
function sendDataRefreshToken(conn, msg) {
  sendData(conn, {type: "refreshToken", messages: msg});
}
function sendReleaseLock(conn, userLocks) {
  sendData(conn, {type: "releaseLock", locks: _.map(userLocks, function(e) {
    return {
      block: e.block,
      user: e.user,
      time: Date.now(),
      changes: null
    };
  })});
}
function getParticipants(docId, excludeClosed, excludeUserId, excludeViewer) {
  return _.filter(connections, function(el) {
    return el.docId === docId && el.isCloseCoAuthoring !== excludeClosed &&
      el.user.id !== excludeUserId && el.user.view !== excludeViewer;
  });
}
function getParticipantUser(docId, includeUserId) {
  return _.filter(connections, function(el) {
    return el.docId === docId && el.user.id === includeUserId;
  });
}
function getConnectionInfo(conn) {
  var user = conn.user;
  var data = {
    id: user.id,
    idOriginal: user.idOriginal,
    username: user.username,
    indexUser: user.indexUser,
    view: user.view,
    connectionId: conn.id,
    isCloseCoAuthoring: conn.isCloseCoAuthoring
  };
  return JSON.stringify(data);
}
function updatePresenceCommandsToArray(outCommands, docId, userId, userInfo) {
  var expireAt = new Date().getTime() + cfgExpPresence * 1000;
  outCommands.push(
    ['zadd', redisKeyPresenceSet + docId, expireAt, userId],
    ['hset', redisKeyPresenceHash + docId, userId, userInfo],
    ['expire', redisKeyPresenceSet + docId, cfgExpPresence],
    ['expire', redisKeyPresenceHash + docId, cfgExpPresence]
  );
}
function* updatePresence(docId, userId, connInfo) {
  var commands = [];
  updatePresenceCommandsToArray(commands, docId, userId, connInfo);
  var expireAt = new Date().getTime() + cfgExpPresence * 1000;
  commands.push(['zadd', redisKeyDocuments, expireAt, docId]);
  var multi = redisClient.multi(commands);
  yield utils.promiseRedis(multi, multi.exec);
}
function* getAllPresence(docId) {
  var now = (new Date()).getTime();
  var multi = redisClient.multi([
      ['zrangebyscore', redisKeyPresenceSet + docId, 0, now],
      ['hvals', redisKeyPresenceHash + docId]
    ]);
  var multiRes = yield utils.promiseRedis(multi, multi.exec);
  var expiredKeys = multiRes[0];
  var hvals = multiRes[1];
  if (expiredKeys.length > 0) {
    var commands = [
      ['zremrangebyscore', redisKeyPresenceSet + docId, 0, now]
    ];
    var expiredKeysMap = {};
    for (var i = 0; i < expiredKeys.length; ++i) {
      var expiredKey = expiredKeys[i];
      expiredKeysMap[expiredKey] = 1;
      commands.push(['hdel', redisKeyPresenceHash + docId, expiredKey]);
    }
    multi = redisClient.multi(commands);
    yield utils.promiseRedis(multi, multi.exec);
    hvals = hvals.filter(function(curValue) {
      return null == expiredKeysMap[curValue];
    })
  }
  return hvals;
}
function* hasEditors(docId, opt_hvals) {
  var elem, hasEditors = false;
  var hvals;
  if(opt_hvals){
    hvals = opt_hvals;
  } else {
    hvals = yield* getAllPresence(docId);
  }
  for (var i = 0; i < hvals.length; ++i) {
    elem = JSON.parse(hvals[i]);
    if(!elem.view && !elem.isCloseCoAuthoring) {
      hasEditors = true;
      break;
    }
  }
  return hasEditors;
}
function* isUserReconnect(docId, userId, connectionId) {
  var elem;
  var hvals = yield* getAllPresence(docId);
  for (var i = 0; i < hvals.length; ++i) {
    elem = JSON.parse(hvals[i]);
    if (userId === elem.id && connectionId !== elem.connectionId) {
      return true;
    }
  }
  return false;
}
function* publish(data, optDocId, optUserId) {
  var needPublish = true;
  if(optDocId && optUserId) {
    needPublish = false;
    var hvals = yield* getAllPresence(optDocId);
    for (var i = 0; i < hvals.length; ++i) {
      var elem = JSON.parse(hvals[i]);
      if(optUserId != elem.id) {
        needPublish = true;
        break;
      }
    }
  }
  if(needPublish) {
    var msg = JSON.stringify(data);
    pubsub.publish(msg);
  }
}
function* addTask(data, priority, opt_queue) {
  var realQueue = opt_queue ? opt_queue : queue;
  yield realQueue.addTask(data, priority);
}
function* removeResponse(data) {
  yield queue.removeResponse(data);
}

function* getOriginalParticipantsId(docId) {
  var result = [], tmpObject = {};
  var hvals = yield* getAllPresence(docId);
  for (var i = 0; i < hvals.length; ++i) {
    var elem = JSON.parse(hvals[i]);
    if (!elem.view && !elem.isCloseCoAuthoring) {
      tmpObject[elem.idOriginal] = 1;
    }
  }
  for (var name in tmpObject) if (tmpObject.hasOwnProperty(name)) {
    result.push(name);
  }
  return result;
}

function* sendServerRequest(docId, uri, dataObject) {
  logger.debug('postData request: docId = %s;url = %s;data = %j', docId, uri, dataObject);
  var authorization;
  if (cfgTokenEnableRequestOutbox) {
    authorization = utils.fillJwtForRequest(dataObject);
  }
  var res = yield utils.postRequestPromise(uri, JSON.stringify(dataObject), cfgCallbackRequestTimeout * 1000, authorization);
  logger.debug('postData response: docId = %s;data = %s', docId, res);
  return res;
}
function parseUrl(callbackUrl) {
  var result = null;
  try {
    var parseObject = url.parse(callbackUrl);
    var isHttps = 'https:' === parseObject.protocol;
    var port = parseObject.port;
    if (!port) {
      port = isHttps ? defaultHttpsPort : defaultHttpPort;
    }
    result = {
      'https': isHttps,
      'host': parseObject.hostname,
      'port': port,
      'path': parseObject.path,
      'href': parseObject.href
    };
  } catch (e) {
    logger.error("error parseUrl %s:\r\n%s", callbackUrl, e.stack);
    result = null;
  }

  return result;
}

function* deleteCallback(id) {
  yield sqlBase.deleteCallbackPromise(id);
}
function* getCallback(id) {
  var callbackUrl = null;
  var baseUrl = null;
  var selectRes = yield sqlBase.getCallbackPromise(id);
  if (selectRes.length > 0) {
    var row = selectRes[0];
    if (row.callback) {
      callbackUrl = row.callback;
    }
    if (row.baseurl) {
      baseUrl = row.baseurl;
    }
  }
  if (null != callbackUrl && null != baseUrl) {
    return {server: parseUrl(callbackUrl), baseUrl: baseUrl};
  } else {
    return null;
  }
}
function* addCallback(id, href, baseUrl) {
  yield sqlBase.insertCallbackPromise(id, href, baseUrl);
}
function* getChangesIndex(docId) {
  var res = 0;
  var redisRes = yield utils.promiseRedis(redisClient, redisClient.get, redisKeyChangeIndex + docId);
  if (null != redisRes) {
    res = parseInt(redisRes);
  } else {
    var getRes = yield sqlBase.getChangesIndexPromise(docId);
    if (getRes && getRes.length > 0 && null != getRes[0]['change_id']) {
      res = getRes[0]['change_id'] + 1;
    }
  }
  return res;
}
function* setForceSave(docId, lastSave, savePathDoc) {
  yield utils.promiseRedis(redisClient, redisClient.hset, redisKeyForceSave + docId, lastSave, savePathDoc);
}
function* sendStatusDocument(docId, bChangeBase, userAction, callback, baseUrl, opt_userData) {
  if (!callback) {
    var getRes = yield* getCallback(docId);
    if (getRes) {
      callback = getRes.server;
      if (!baseUrl) {
        baseUrl = getRes.baseUrl;
      }
    }
  }
  if (null == callback) {
    return;
  }

  var status = c_oAscServerStatus.Editing;
  var participants = yield* getOriginalParticipantsId(docId);
  if (0 === participants.length) {
    var puckerIndex = yield* getChangesIndex(docId);
    if (!(puckerIndex > 0)) {
      status = c_oAscServerStatus.Closed;
    }
  }

  if (c_oAscChangeBase.No !== bChangeBase) {
    if (c_oAscServerStatus.Editing === status && c_oAscChangeBase.All === bChangeBase) {
      yield* addCallback(docId, callback.href, baseUrl);
    } else if (c_oAscServerStatus.Closed === status) {
      yield* deleteCallback(docId);
    }
  }

  var sendData = new commonDefines.OutputSfcData();
  sendData.setKey(docId);
  sendData.setStatus(status);
  if (c_oAscServerStatus.Closed !== status) {
    sendData.setUsers(participants);
  }
  if (userAction) {
    sendData.setActions([userAction]);
  }
  if (opt_userData) {
    sendData.setUserData(opt_userData);
  }
  var uri = callback.href;
  var replyData = null;
  try {
    replyData = yield* sendServerRequest(docId, uri, sendData);
  } catch (err) {
    replyData = null;
    logger.error('postData error: docId = %s;url = %s;data = %j\r\n%s', docId, uri, sendData, err.stack);
  }
  yield* onReplySendStatusDocument(docId, replyData);
}
function parseReplyData(docId, replyData) {
  var res = null;
  if (replyData) {
    try {
      res = JSON.parse(replyData);
    } catch (e) {
      logger.error("error parseReplyData: docId = %s; data = %s\r\n%s", docId, replyData, e.stack);
      res = null;
    }
  }
  return res;
}
function* onReplySendStatusDocument(docId, replyData) {
  var oData = parseReplyData(docId, replyData);
  if (!(oData && commonDefines.c_oAscServerCommandErrors.NoError == oData.error)) {
    yield* publish({type: commonDefines.c_oPublishType.warning, docId: docId, description: 'Error on save server subscription!'});
  }
}
function* dropUsersFromDocument(docId, users) {
  if (Array.isArray(users)) {
    yield* publish({type: commonDefines.c_oPublishType.drop, docId: docId, users: users, description: ''});
  }
}

function dropUserFromDocument(docId, userId, description) {
  var elConnection;
  for (var i = 0, length = connections.length; i < length; ++i) {
    elConnection = connections[i];
    if (elConnection.docId === docId && userId === elConnection.user.idOriginal && !elConnection.isCloseCoAuthoring) {
      sendData(elConnection,
        {
          type: "drop",
          description: description
        });//Or 0 if fails
    }
  }
}
function* bindEvents(docId, callback, baseUrl, opt_userAction, opt_userData) {
  var bChangeBase;
  var oCallbackUrl;
  var getRes = yield* getCallback(docId);
  if (getRes) {
    oCallbackUrl = getRes.server;
    bChangeBase = c_oAscChangeBase.Delete;
  } else {
    oCallbackUrl = parseUrl(callback);
    bChangeBase = c_oAscChangeBase.All;
    if (null !== oCallbackUrl) {
      var hostIp = yield utils.dnsLookup(oCallbackUrl.host);
      if (utils.checkIpFilter(hostIp, oCallbackUrl.host) > 0) {
        logger.error('checkIpFilter error: docId = %s;url = %s', docId, callback);
        oCallbackUrl = null;
      }
    }
  }
  if (null === oCallbackUrl) {
    return commonDefines.c_oAscServerCommandErrors.ParseError;
  } else {
    yield* sendStatusDocument(docId, bChangeBase, opt_userAction, oCallbackUrl, baseUrl, opt_userData);
    return commonDefines.c_oAscServerCommandErrors.NoError;
  }
}

function* cleanDocumentOnExit(docId, deleteChanges) {
  var redisArgs = [redisClient, redisClient.del, redisKeyLocks + docId,
      redisKeyMessage + docId, redisKeyChangeIndex + docId, redisKeyForceSave + docId, redisKeyLastSave + docId];
  utils.promiseRedis.apply(this, redisArgs);
  yield* deleteCallback(docId);
  if (deleteChanges) {
    sqlBase.deleteChanges(docId, null);
  }
}
function* cleanDocumentOnExitNoChanges(docId, opt_userId) {
  var userAction = opt_userId ? new commonDefines.OutputAction(commonDefines.c_oAscUserAction.Out, opt_userId) : null;
  yield* sendStatusDocument(docId, c_oAscChangeBase.No, userAction);
  yield* cleanDocumentOnExit(docId, false);
}

function* _createSaveTimer(docId, opt_userId, opt_queue, opt_noDelay) {
  var updateMask = new taskResult.TaskResultData();
  updateMask.key = docId;
  updateMask.status = taskResult.FileStatus.Ok;
  var updateTask = new taskResult.TaskResultData();
  updateTask.status = taskResult.FileStatus.SaveVersion;
  updateTask.statusInfo = utils.getMillisecondsOfHour(new Date());
  var updateIfRes = yield taskResult.updateIf(updateTask, updateMask);
  if (updateIfRes.affectedRows > 0) {
    if(!opt_noDelay){
      yield utils.sleep(cfgAscSaveTimeOutDelay);
    }
    while (true) {
      if (!sqlBase.isLockCriticalSection(docId)) {
        canvasService.saveFromChanges(docId, updateTask.statusInfo, null, opt_userId, opt_queue);
        break;
      }
      yield utils.sleep(c_oAscLockTimeOutDelay);
    }
  } else {
    logger.debug('_createSaveTimer updateIf no effect');
  }
}

function checkJwt(docId, token, isSession) {
  var res = {decoded: null, description: null, code: null, token: token};
  var secret;
  if (isSession) {
    secret = utils.getSecretByElem(cfgSecretSession);
  } else {
    secret = utils.getSecret(docId, null, token);
  }
  if (undefined == secret) {
    logger.error('empty secret: docId = %s token = %s', docId, token);
  }
  try {
    res.decoded = jwt.verify(token, secret);
    logger.debug('checkJwt success: docId = %s decoded = %j', docId, res.decoded);
  } catch (err) {
    logger.warn('checkJwt error: docId = %s name = %s message = %s token = %s', docId, err.name, err.message, token);
    if ('TokenExpiredError' === err.name) {
      res.code = constants.JWT_EXPIRED_CODE;
      res.description = constants.JWT_EXPIRED_REASON + err.message;
    } else if ('JsonWebTokenError' === err.name) {
      res.code = constants.JWT_ERROR_CODE;
      res.description = constants.JWT_ERROR_REASON + err.message;
    }
  }
  return res;
}
function checkJwtHeader(docId, req) {
  var authorization = req.get(cfgTokenInboxHeader);
  if (authorization && authorization.startsWith(cfgTokenInboxPrefix)) {
    var token = authorization.substring(cfgTokenInboxPrefix.length);
    return checkJwt(docId, token, false);
  }
  return null;
}
function checkJwtPayloadHash(docId, hash, body, token) {
  var res = false;
  if (body && Buffer.isBuffer(body)) {
    var decoded = jwt.decode(token, {complete: true});
    var hmac = jwa(decoded.header.alg);
    var secret = utils.getSecret(docId, null, token);
    var signature = hmac.sign(body, secret);
    res = (hash === signature);
  }
  return res;
}

exports.version = asc_coAuthV;
exports.c_oAscServerStatus = c_oAscServerStatus;
exports.sendData = sendData;
exports.parseUrl = parseUrl;
exports.parseReplyData = parseReplyData;
exports.sendServerRequest = sendServerRequest;
exports.createSaveTimerPromise = co.wrap(_createSaveTimer);
exports.getAllPresencePromise = co.wrap(getAllPresence);
exports.publish = publish;
exports.addTask = addTask;
exports.removeResponse = removeResponse;
exports.hasEditors = hasEditors;
exports.getCallback = getCallback;
exports.getIsShutdown = getIsShutdown;
exports.getChangesIndexPromise = co.wrap(getChangesIndex);
exports.cleanDocumentOnExitPromise = co.wrap(cleanDocumentOnExit);
exports.cleanDocumentOnExitNoChangesPromise = co.wrap(cleanDocumentOnExitNoChanges);
exports.setForceSave= setForceSave;
exports.checkJwt = checkJwt;
exports.checkJwtHeader = checkJwtHeader;
exports.checkJwtPayloadHash = checkJwtPayloadHash;
exports.install = function(server, callbackFunction) {
  var sockjs_opts = {sockjs_url: cfgSockjsUrl},
    sockjs_echo = sockjs.createServer(sockjs_opts),
    urlParse = new RegExp("^/doc/([" + constants.DOC_ID_PATTERN + "]*)/c.+", 'i');

  sockjs_echo.on('connection', function(conn) {
    if (null == conn) {
      logger.error("null == conn");
      return;
    }
    if (getIsShutdown()) {
      sendFileError(conn, 'Server shutdow');
      return;
    }
    conn.baseUrl = utils.getBaseUrlByConnection(conn);
    conn.sessionIsSendWarning = false;
    conn.sessionTimeConnect = conn.sessionTimeLastAction = new Date().getTime();

    conn.on('data', function(message) {
      return co(function* () {
      var docId = 'null';
      try {
        var startDate = null;
        if(clientStatsD) {
          startDate = new Date();
        }
        var data = JSON.parse(message);
        docId = conn.docId;
        logger.info('data.type = ' + data.type + ' id = ' + docId);
        if(getIsShutdown())
        {
          logger.debug('Server shutdown receive data');
          return;
        }
        if (conn.isCiriticalError && ('message' == data.type || 'getLock' == data.type || 'saveChanges' == data.type ||
            'isSaveLock' == data.type)) {
          logger.warn("conn.isCiriticalError send command: docId = %s type = %s", docId, data.type);
          conn.close(constants.ACCESS_DENIED_CODE, constants.ACCESS_DENIED_REASON);
          return;
        }
        if ((conn.isCloseCoAuthoring || (conn.user && conn.user.view)) &&
            ('getLock' == data.type || 'saveChanges' == data.type || 'isSaveLock' == data.type)) {
          logger.warn("conn.user.view||isCloseCoAuthoring access deny: docId = %s type = %s", docId, data.type);
          conn.close(constants.ACCESS_DENIED_CODE, constants.ACCESS_DENIED_REASON);
          return;
        }
        switch (data.type) {
          case 'auth'          :
            yield* auth(conn, data);
            break;
          case 'message'        :
            yield* onMessage(conn, data);
            break;
          case 'cursor'        :
            yield* onCursor(conn, data);
            break;
          case 'getLock'        :
            yield* getLock(conn, data, false);
            break;
          case 'saveChanges'      :
            yield* saveChanges(conn, data);
            break;
          case 'isSaveLock'      :
            yield* isSaveLock(conn, data);
            break;
          case 'unSaveLock'      :
            yield* unSaveLock(conn, -1);
            break;	// Индекс отправляем -1, т.к. это экстренное снятие без сохранения
          case 'getMessages'      :
            yield* getMessages(conn, data);
            break;
          case 'unLockDocument'    :
            yield* checkEndAuthLock(data.isSave, docId, conn.user.id, conn);
            break;
          case 'close':
            yield* closeDocument(conn, false);
            break;
          case 'versionHistory'          :
            yield* versionHistory(conn, new commonDefines.InputCommand(data.cmd));
            break;
          case 'openDocument'      :
            var cmd = new commonDefines.InputCommand(data.message);
            yield canvasService.openDocument(conn, cmd);
            break;
          case 'changesError':
            logger.error("changesError: docId = %s %s", docId, data.stack);
            break;
          case 'extendSession' :
            conn.sessionIsSendWarning = false;
            conn.sessionTimeLastAction = new Date().getTime() - data.idletime;
            break;
          case 'refreshToken' :
            var isSession = !!data.jwtSession;
            var checkJwtRes = checkJwt(docId, data.jwtSession || data.jwtOpen, isSession);
            if (checkJwtRes.decoded) {
              if (checkJwtRes.decoded.document.key == conn.docId) {
                sendDataRefreshToken(conn, {token: fillJwtByConnection(conn), expires: cfgTokenSessionExpires});
              } else {
                conn.close(constants.ACCESS_DENIED_CODE, constants.ACCESS_DENIED_REASON);
              }
            } else {
              conn.close(checkJwtRes.code, checkJwtRes.description);
            }
            break;
          default:
            logger.debug("unknown command %s", message);
            break;
        }
        if(clientStatsD) {
          if('openDocument' != data.type) {
            clientStatsD.timing('coauth.data.' + data.type, new Date() - startDate);
          }
        }
      } catch (e) {
        logger.error("error receiving response: docId = %s type = %s\r\n%s", docId, (data && data.type) ? data.type : 'null', e.stack);
      }
      });
    });
    conn.on('error', function() {
      logger.error("On error");
    });
    conn.on('close', function() {
      return co(function* () {
        var docId = 'null';
        try {
          docId = conn.docId;
          yield* closeDocument(conn, true);
        } catch (err) {
          logger.error('Error conn close: docId = %s\r\n%s', docId, err.stack);
        }
      });
    });

    _checkLicense(conn);
  });
  function* closeDocument(conn, isCloseConnection) {
    var userLocks, reconnected = false, bHasEditors, bHasChanges;
    var docId = conn.docId;
    if (null == docId) {
      return;
    }
    var hvals;
    var tmpUser = conn.user;
    var isView = tmpUser.view;
    logger.info("Connection closed or timed out: userId = %s isCloseConnection = %s docId = %s", tmpUser.id, isCloseConnection, docId);
    var isCloseCoAuthoringTmp = conn.isCloseCoAuthoring;
    if (isCloseConnection) {
      connections = _.reject(connections, function(el) {
        return el.id === conn.id;//Delete this connection
      });
      reconnected = yield* isUserReconnect(docId, tmpUser.id, conn.id);
      if (reconnected) {
        logger.info("reconnected: userId = %s docId = %s", tmpUser.id, docId);
      } else {
        var multi = redisClient.multi([['hdel', redisKeyPresenceHash + docId, tmpUser.id],
                                        ['zrem', redisKeyPresenceSet + docId, tmpUser.id]]);
        yield utils.promiseRedis(multi, multi.exec);
        hvals = yield* getAllPresence(docId);
        if (hvals.length <= 0) {
          yield utils.promiseRedis(redisClient, redisClient.zrem, redisKeyDocuments, docId);
        }
      }
    } else {
      if (!conn.isCloseCoAuthoring) {
        tmpUser.view = true;
        conn.isCloseCoAuthoring = true;
        yield* updatePresence(docId, tmpUser.id, getConnectionInfo(conn));
        if (cfgTokenEnableBrowser) {
          sendDataRefreshToken(conn, {token: fillJwtByConnection(conn), expires: cfgTokenSessionExpires});
        }
      }
    }

    if (isCloseCoAuthoringTmp) {
      return;
    }

    if (!reconnected) {
      var tmpView = tmpUser.view;
      tmpUser.view = isView;
      yield* publish({type: commonDefines.c_oPublishType.participantsState, docId: docId, user: tmpUser, state: false}, docId, tmpUser.id);
      tmpUser.view = tmpView;
      var saveLock = yield utils.promiseRedis(redisClient, redisClient.get, redisKeySaveLock + docId);
      if (conn.user.id == saveLock) {
        yield utils.promiseRedis(redisClient, redisClient.del, redisKeySaveLock + docId);
      }
      if (false === isView) {
        bHasEditors = yield* hasEditors(docId, hvals);
        var puckerIndex = yield* getChangesIndex(docId);
        bHasChanges = puckerIndex > 0;
        if (!bHasEditors) {
          yield utils.promiseRedis(redisClient, redisClient.del, redisKeySaveLock + docId);
          if (bHasChanges) {
            yield* _createSaveTimer(docId, tmpUser.idOriginal);
          } else {
            yield* cleanDocumentOnExitNoChanges(docId, tmpUser.idOriginal);
          }
        } else {
          yield* sendStatusDocument(docId, c_oAscChangeBase.No, new commonDefines.OutputAction(commonDefines.c_oAscUserAction.Out, tmpUser.idOriginal));
        }
        userLocks = yield* getUserLocks(docId, conn.sessionId);
        if (0 < userLocks.length) {
          yield* publish({type: commonDefines.c_oPublishType.releaseLock, docId: docId, userId: conn.user.id, locks: userLocks}, docId, conn.user.id);
        }
        yield* checkEndAuthLock(false, docId, conn.user.id);
      }
    }
  }

  function* versionHistory(conn, cmd) {
    var docIdOld = conn.docId;
    var docIdNew = cmd.getDocId();
    if (docIdOld !== docIdNew) {
      var tmpUser = conn.user;
      var multi = redisClient.multi([
                                      ['hdel', redisKeyPresenceHash + docIdOld, tmpUser.id],
                                      ['zrem', redisKeyPresenceSet + docIdOld, tmpUser.id]
                                    ]);
      yield utils.promiseRedis(multi, multi.exec);
      var hvals = yield* getAllPresence(docIdOld);
      if (hvals.length <= 0) {
        yield utils.promiseRedis(redisClient, redisClient.zrem, redisKeyDocuments, docIdOld);
      }
      conn.docId = docIdNew;
      yield* updatePresence(docIdNew, tmpUser.id, getConnectionInfo(conn));
      if (cfgTokenEnableBrowser) {
        sendDataRefreshToken(conn, {token: fillJwtByConnection(conn), expires: cfgTokenSessionExpires});
      }
    }
    yield canvasService.openDocument(conn, cmd, null);
  }
  function* getDocumentChanges(docId, optStartIndex, optEndIndex) {
    var arrayElements = yield sqlBase.getChangesPromise(docId, optStartIndex, optEndIndex);
    var j, element;
    var objChangesDocument = new DocumentChanges(docId);
    for (j = 0; j < arrayElements.length; ++j) {
      element = arrayElements[j];
      objChangesDocument.push({docid: docId, change: element['change_data'],
        time: element['change_date'].getTime(), user: element['user_id'],
        useridoriginal: element['user_id_original']});
    }
    return objChangesDocument;
  }

  function* getAllLocks(docId) {
    var docLockRes = [];
    var docLock = yield utils.promiseRedis(redisClient, redisClient.lrange, redisKeyLocks + docId, 0, -1);
    for (var i = 0; i < docLock.length; ++i) {
      docLockRes.push(JSON.parse(docLock[i]));
    }
    return docLockRes;
  }
  function* addLocks(docId, toCache, isReplace) {
    if (toCache && toCache.length > 0) {
      toCache.unshift('rpush', redisKeyLocks + docId);
      var multiArgs = [toCache, ['expire', redisKeyLocks + docId, cfgExpLocks]];
      if (isReplace) {
        multiArgs.unshift(['del', redisKeyLocks + docId]);
      }
      var multi = redisClient.multi(multiArgs);
      yield utils.promiseRedis(multi, multi.exec);
    }
  }
  function* getUserLocks(docId, sessionId) {
    var userLocks = [], i;
    var toCache = [];
    var docLock = yield* getAllLocks(docId);
    for (i = 0; i < docLock.length; ++i) {
      var elem = docLock[i];
      if (elem.sessionId === sessionId) {
        userLocks.push(elem);
      } else {
        toCache.push(JSON.stringify(elem));
      }
    }
    yield utils.promiseRedis(redisClient, redisClient.del, redisKeyLocks + docId);
    yield* addLocks(docId, toCache);
    return userLocks;
  }

  function* getParticipantMap(docId) {
    var participantsMap = [];
    var hvals = yield* getAllPresence(docId);
    for (var i = 0; i < hvals.length; ++i) {
      var elem = JSON.parse(hvals[i]);
      if (!elem.isCloseCoAuthoring) {
        participantsMap.push(elem);
      }
    }
    return participantsMap;
  }

  function* checkEndAuthLock(isSave, docId, userId, currentConnection) {
    var result = false;
    var lockDocument = yield utils.promiseRedis(redisClient, redisClient.get, redisKeyLockDoc + docId);
    if (lockDocument && userId === JSON.parse(lockDocument).id) {
      yield utils.promiseRedis(redisClient, redisClient.del, redisKeyLockDoc + docId);

      var participantsMap = yield* getParticipantMap(docId);
      yield* publish({type: commonDefines.c_oPublishType.auth, docId: docId, userId: userId, participantsMap: participantsMap}, docId, userId);

      result = true;
    } else if (isSave) {
      var userLocks = yield* getUserLocks(docId, currentConnection.sessionId);
      if (0 < userLocks.length) {
        sendReleaseLock(currentConnection, userLocks);
        yield* publish({type: commonDefines.c_oPublishType.releaseLock, docId: docId, userId: userId, locks: userLocks}, docId, userId);
      }
      yield* unSaveLock(currentConnection, -1);
    }
    return result;
  }

  function sendParticipantsState(participants, data) {
    _.each(participants, function(participant) {
      sendData(participant, {
        type: "connectState",
        state: data.state,
        user: data.user
      });
    });
  }

  function sendFileError(conn, errorId) {
    logger.error('error description: docId = %s errorId = %s', conn.docId, errorId);
    conn.isCiriticalError = true;
    sendData(conn, {type: 'error', description: errorId});
  }
  function _recalcLockArray(userId, _locks, oRecalcIndexColumns, oRecalcIndexRows) {
    if (null == _locks) {
      return false;
    }
    var count = _locks.length;
    var element = null, oRangeOrObjectId = null;
    var i;
    var sheetId = -1;
    var isModify = false;
    for (i = 0; i < count; ++i) {
      if (userId === _locks[i].user) {
        continue;
      }
      element = _locks[i].block;
      if (c_oAscLockTypeElem.Range !== element["type"] ||
        c_oAscLockTypeElemSubType.InsertColumns === element["subType"] ||
        c_oAscLockTypeElemSubType.InsertRows === element["subType"]) {
        continue;
      }
      sheetId = element["sheetId"];

      oRangeOrObjectId = element["rangeOrObjectId"];

      if (oRecalcIndexColumns && oRecalcIndexColumns.hasOwnProperty(sheetId)) {
        oRangeOrObjectId["c1"] = oRecalcIndexColumns[sheetId].getLockMe2(oRangeOrObjectId["c1"]);
        oRangeOrObjectId["c2"] = oRecalcIndexColumns[sheetId].getLockMe2(oRangeOrObjectId["c2"]);
        isModify = true;
      }
      if (oRecalcIndexRows && oRecalcIndexRows.hasOwnProperty(sheetId)) {
        oRangeOrObjectId["r1"] = oRecalcIndexRows[sheetId].getLockMe2(oRangeOrObjectId["r1"]);
        oRangeOrObjectId["r2"] = oRecalcIndexRows[sheetId].getLockMe2(oRangeOrObjectId["r2"]);
        isModify = true;
      }
    }
    return isModify;
  }

  function _addRecalcIndex(oRecalcIndex) {
    if (null == oRecalcIndex) {
      return null;
    }
    var nIndex = 0;
    var nRecalcType = c_oAscRecalcIndexTypes.RecalcIndexAdd;
    var oRecalcIndexElement = null;
    var oRecalcIndexResult = {};

    for (var sheetId in oRecalcIndex) {
      if (oRecalcIndex.hasOwnProperty(sheetId)) {
        if (!oRecalcIndexResult.hasOwnProperty(sheetId)) {
          oRecalcIndexResult[sheetId] = new CRecalcIndex();
        }
        for (; nIndex < oRecalcIndex[sheetId]._arrElements.length; ++nIndex) {
          oRecalcIndexElement = oRecalcIndex[sheetId]._arrElements[nIndex];
          if (true === oRecalcIndexElement.m_bIsSaveIndex) {
            continue;
          }
          nRecalcType = (c_oAscRecalcIndexTypes.RecalcIndexAdd === oRecalcIndexElement._recalcType) ?
            c_oAscRecalcIndexTypes.RecalcIndexRemove : c_oAscRecalcIndexTypes.RecalcIndexAdd;
          oRecalcIndexResult[sheetId].add(nRecalcType, oRecalcIndexElement._position,
            oRecalcIndexElement._count, /*bIsSaveIndex*/true);
        }
      }
    }

    return oRecalcIndexResult;
  }

  function compareExcelBlock(newBlock, oldBlock) {
    if (null !== newBlock.subType && null !== oldBlock.subType) {
      return true;
    }
    if ((c_oAscLockTypeElemSubType.ChangeProperties === oldBlock.subType &&
      c_oAscLockTypeElem.Sheet !== newBlock.type) ||
      (c_oAscLockTypeElemSubType.ChangeProperties === newBlock.subType &&
        c_oAscLockTypeElem.Sheet !== oldBlock.type)) {
      return false;
    }

    var resultLock = false;
    if (newBlock.type === c_oAscLockTypeElem.Range) {
      if (oldBlock.type === c_oAscLockTypeElem.Range) {
        if (c_oAscLockTypeElemSubType.InsertRows === oldBlock.subType || c_oAscLockTypeElemSubType.InsertColumns === oldBlock.subType) {
          resultLock = false;
        } else if (isInterSection(newBlock.rangeOrObjectId, oldBlock.rangeOrObjectId)) {
          resultLock = true;
        }
      } else if (oldBlock.type === c_oAscLockTypeElem.Sheet) {
        resultLock = true;
      }
    } else if (newBlock.type === c_oAscLockTypeElem.Sheet) {
      resultLock = true;
    } else if (newBlock.type === c_oAscLockTypeElem.Object) {
      if (oldBlock.type === c_oAscLockTypeElem.Sheet) {
        resultLock = true;
      } else if (oldBlock.type === c_oAscLockTypeElem.Object && oldBlock.rangeOrObjectId === newBlock.rangeOrObjectId) {
        resultLock = true;
      }
    }
    return resultLock;
  }

  function isInterSection(range1, range2) {
    if (range2.c1 > range1.c2 || range2.c2 < range1.c1 || range2.r1 > range1.r2 || range2.r2 < range1.r1) {
      return false;
    }
    return true;
  }
  function comparePresentationBlock(newBlock, oldBlock) {
    var resultLock = false;

    switch (newBlock.type) {
      case c_oAscLockTypeElemPresentation.Presentation:
        if (c_oAscLockTypeElemPresentation.Presentation === oldBlock.type) {
          resultLock = newBlock.val === oldBlock.val;
        }
        break;
      case c_oAscLockTypeElemPresentation.Slide:
        if (c_oAscLockTypeElemPresentation.Slide === oldBlock.type) {
          resultLock = newBlock.val === oldBlock.val;
        }
        else if (c_oAscLockTypeElemPresentation.Object === oldBlock.type) {
          resultLock = newBlock.val === oldBlock.slideId;
        }
        break;
      case c_oAscLockTypeElemPresentation.Object:
        if (c_oAscLockTypeElemPresentation.Slide === oldBlock.type) {
          resultLock = newBlock.slideId === oldBlock.val;
        }
        else if (c_oAscLockTypeElemPresentation.Object === oldBlock.type) {
          resultLock = newBlock.objId === oldBlock.objId;
        }
        break;
    }
    return resultLock;
  }

  function* authRestore(conn, sessionId, documentCallbackUrl) {
    conn.sessionId = sessionId;//restore old
    connections = _.reject(connections, function(el) {
      return el.sessionId === sessionId;//Delete this connection
    });

    yield* endAuth(conn, true, documentCallbackUrl);
  }

  function fillUsername(data) {
    let user = data.user;
    if (user.firstname && user.lastname) {
      let isRu = (data.lang && /^ru/.test(data.lang));
      return isRu ? user.lastname + ' ' + user.firstname : user.firstname + ' ' + user.lastname;
    } else {
      return user.username;
    }
  }
  function isEditMode(permissions, mode, def) {
    if (permissions && mode) {
      return (permissions.edit !== false || permissions.review === true) && mode !== 'view';
    } else {
      return def;
    }
  }
  function fillDataFromJwt(decoded, data) {
    var openCmd = data.openCmd;
    if (decoded.document) {
      var doc = decoded.document;
      if(null != doc.key){
        data.docid = doc.key;
        if(openCmd){
          openCmd.id = doc.key;
        }
      }
      if(doc.permissions) {
        if(!data.permissions){
          data.permissions = {};
        }
        Object.assign(data.permissions, doc.permissions);
      }
      if(openCmd){
        if(null != doc.fileType) {
          openCmd.format = doc.fileType;
        }
        if(null != doc.title) {
          openCmd.title = doc.title;
        }
        if(null != doc.url) {
          openCmd.url = doc.url;
        }
      }
    }
    if (decoded.editorConfig) {
      var edit = decoded.editorConfig;
      if (null != edit.callbackUrl) {
        data.documentCallbackUrl = edit.callbackUrl;
      }
      if (null != edit.lang) {
        data.lang = edit.lang;
      }
      if (null != edit.mode) {
        data.mode = edit.mode;
      }
      if (null != edit.ds_view) {
        data.view = edit.ds_view;
      }
      if (null != edit.ds_isCloseCoAuthoring) {
        data.isCloseCoAuthoring = edit.ds_isCloseCoAuthoring;
      }
      if (edit.user) {
        var user = edit.user;
        if (null != user.id) {
          data.id = user.id;
          if (openCmd) {
            openCmd.userid = user.id;
          }
        }
        if (null != user.firstname) {
          data.firstname = user.firstname;
        }
        if (null != user.lastname) {
          data.lastname = user.lastname;
        }
        if (null != user.name) {
          data.username = user.name;
        }
      }
    }
    if (decoded.iss) {
      data.iss = decoded.iss;
    }
  }
  function fillJwtByConnection(conn) {
    var docId = conn.docId;
    var payload = {document: {}, editorConfig: {user: {}}};
    var doc = payload.document;
    doc.key = conn.docId;
    doc.permissions = conn.permissions;
    var edit = payload.editorConfig;
    var user = edit.user;
    user.id = conn.user.idOriginal;
    user.name = conn.user.username;
    edit.ds_view = conn.user.view;
    edit.ds_isCloseCoAuthoring = conn.isCloseCoAuthoring;

    var options = {algorithm: cfgTokenSessionAlgorithm, expiresIn: cfgTokenSessionExpires / 1000};
    var secret = utils.getSecretByElem(cfgSecretSession);
    return jwt.sign(payload, secret, options);
  }

  function* auth(conn, data) {
    if (data.version !== asc_coAuthV) {
      sendFileError(conn, 'Old Version Sdk');
      return;
    }
    if (data.token && data.user) {
      var docId = data.docid;
      if (cfgTokenEnableBrowser) {
        var isSession = !!data.jwtSession;
        var checkJwtRes = checkJwt(docId, data.jwtSession || data.jwtOpen, isSession);
        if (checkJwtRes.decoded) {
          fillDataFromJwt(checkJwtRes.decoded, data);
        } else {
          conn.close(checkJwtRes.code, checkJwtRes.description);
          return;
        }
      }

      docId = data.docid;
      var user = data.user;
      var bIsRestore = null != data.sessionId;
      var upsertRes = null;
      var cmd = data.openCmd ? new commonDefines.InputCommand(data.openCmd) : null;
      var curIndexUser;
      if (bIsRestore) {
        curIndexUser = user.indexUser;
      } else {
        upsertRes = yield canvasService.commandOpenStartPromise(docId, cmd, true);
        upsertRes.affectedRows == 1 ? curIndexUser = 1 : curIndexUser = upsertRes.insertId;
      }
      if (constants.CONN_CLOSED === conn.readyState) {
        return;
      }

      var curUserId = user.id + curIndexUser;
      conn.docId = data.docid;
      conn.permissions = data.permissions;
      conn.user = {
        id: curUserId,
        idOriginal: user.id,
        username: fillUsername(data),
        indexUser: curIndexUser,
        view: !isEditMode(data.permissions, data.mode, !data.view)
      };
      conn.isCloseCoAuthoring = data.isCloseCoAuthoring;
      conn.editorType = data['editorType'];
      if (data.sessionTimeConnect) {
        conn.sessionTimeConnect = data.sessionTimeConnect;
      }
      if (data.sessionTimeIdle) {
        conn.sessionTimeLastAction = new Date().getTime() - data.sessionTimeIdle;
      }
      if (bIsRestore && data.isCloseCoAuthoring) {
        connections = _.reject(connections, function(el) {
          return el.sessionId === data.sessionId;//Delete this connection
        });
        connections.push(conn);
        yield* updatePresence(docId, conn.user.id, getConnectionInfo(conn));
        yield* sendAuthInfo(undefined, undefined, conn, undefined);
        if (cmd) {
          yield canvasService.openDocument(conn, cmd, upsertRes);
        }
        return;
      }
      if (bIsRestore) {
        logger.info("restored old session: docId = %s id = %s", docId, data.sessionId);

        if (!conn.user.view) {
          try {
            var result = yield sqlBase.checkStatusFilePromise(docId);

            var status = result && result.length > 0 ? result[0]['status'] : null;
            if (taskResult.FileStatus.Ok === status) {
            } else if (taskResult.FileStatus.SaveVersion === status) {
              var updateMask = new taskResult.TaskResultData();
              updateMask.key = docId;
              updateMask.status = status;
              updateMask.statusInfo = result[0]['status_info'];
              var updateTask = new taskResult.TaskResultData();
              updateTask.status = taskResult.FileStatus.Ok;
              updateTask.statusInfo = constants.NO_ERROR;
              var updateIfRes = yield taskResult.updateIf(updateTask, updateMask);
              if (!(updateIfRes.affectedRows > 0)) {
                sendFileError(conn, 'Update Version error');
                return;
              }
            } else if (taskResult.FileStatus.UpdateVersion === status) {
              sendFileError(conn, 'Update Version error');
              return;
            } else {
              sendFileError(conn, 'Other error');
              return;
            }

            var objChangesDocument = yield* getDocumentChanges(docId);
            var bIsSuccessRestore = true;
            if (objChangesDocument && 0 < objChangesDocument.arrChanges.length) {
              var change = objChangesDocument.arrChanges[objChangesDocument.getLength() - 1];
              if (change['change']) {
                if (change['user'] !== curUserId) {
                  bIsSuccessRestore = 0 === (((data['lastOtherSaveTime'] - change['time']) / 1000) >> 0);
                }
              }
            }

            if (bIsSuccessRestore) {
              var arrayBlocks = data['block'];
              var getLockRes = yield* getLock(conn, data, true);
              if (arrayBlocks && (0 === arrayBlocks.length || getLockRes)) {
                yield* authRestore(conn, data.sessionId, data.documentCallbackUrl);
              } else {
                sendFileError(conn, 'Restore error. Locks not checked.');
              }
            } else {
              sendFileError(conn, 'Restore error. Document modified.');
            }
          } catch (err) {
            logger.error("DataBase error: docId = %s %s", docId, err.stack);
            sendFileError(conn, 'DataBase error');
          }
        } else {
          yield* authRestore(conn, data.sessionId, data.documentCallbackUrl);
        }
      } else {
        conn.sessionId = conn.id;
        var endAuthRes = yield* endAuth(conn, false, data.documentCallbackUrl);
        if (endAuthRes && cmd) {
          yield canvasService.openDocument(conn, cmd, upsertRes);
        }
      }
    }
  }

  function* endAuth(conn, bIsRestore, documentCallbackUrl) {
    var res = true;
    var docId = conn.docId;
    var tmpUser = conn.user;
    if (constants.CONN_CLOSED === conn.readyState) {
      return false;
    }
    connections.push(conn);
    yield* updatePresence(docId, tmpUser.id, getConnectionInfo(conn));
    var firstParticipantNoView, countNoView = 0;
    var participantsMap = yield* getParticipantMap(docId);
    for (var i = 0; i < participantsMap.length; ++i) {
      var elem = participantsMap[i];
      if (!elem.view) {
        ++countNoView;
        if (!firstParticipantNoView && elem.id != tmpUser.id) {
          firstParticipantNoView = elem;
        }
      }
    }
    var bindEventsRes = commonDefines.c_oAscServerCommandErrors.NoError;
    if (!tmpUser.view) {
      var userAction = new commonDefines.OutputAction(commonDefines.c_oAscUserAction.In, tmpUser.idOriginal);
      if (documentCallbackUrl) {
        bindEventsRes = yield* bindEvents(docId, documentCallbackUrl, conn.baseUrl, userAction);
      } else {
        yield* sendStatusDocument(docId, c_oAscChangeBase.No, userAction);
      }
    }

    if (commonDefines.c_oAscServerCommandErrors.NoError === bindEventsRes) {
      var lockDocument = null;
      if (!bIsRestore && 2 === countNoView && !tmpUser.view) {
        var isLock = yield utils.promiseRedis(redisClient, redisClient.setnx,
                                              redisKeyLockDoc + docId, JSON.stringify(firstParticipantNoView));
        if (isLock) {
          lockDocument = firstParticipantNoView;
          yield utils.promiseRedis(redisClient, redisClient.expire, redisKeyLockDoc + docId, cfgExpLockDoc);
        }
      }
      if (!lockDocument) {
        var getRes = yield utils.promiseRedis(redisClient, redisClient.get, redisKeyLockDoc + docId);
        if (getRes) {
          lockDocument = JSON.parse(getRes);
        }
      }

      if (lockDocument && !tmpUser.view) {
        var sendObject = {
          type: "waitAuth",
          lockDocument: lockDocument
        };
        sendData(conn, sendObject);//Or 0 if fails
      } else {
        if (bIsRestore) {
          yield* sendAuthInfo(undefined, undefined, conn, participantsMap);
        } else {
          var objChangesDocument = yield* getDocumentChanges(docId);
          yield* sendAuthInfo(objChangesDocument.arrChanges, objChangesDocument.getLength(), conn, participantsMap);
        }
      }
      yield* publish({type: commonDefines.c_oPublishType.participantsState, docId: docId, user: tmpUser, state: true}, docId, tmpUser.id);
    } else {
      sendFileError(conn, 'ip filter');
      res = false;
    }
    return res;
  }

  function* sendAuthInfo(objChangesDocument, changesIndex, conn, participantsMap) {
    var docId = conn.docId;
    var docLock;
    if(EditorTypes.document == conn.editorType){
      docLock = {};
      var allLocks = yield* getAllLocks(docId);
      for(var i = 0 ; i < allLocks.length; ++i) {
        var elem = allLocks[i];
        docLock[elem.block] =elem;
      }
    } else {
      docLock = yield* getAllLocks(docId);
    }
    var allMessages = yield utils.promiseRedis(redisClient, redisClient.lrange, redisKeyMessage + docId, 0, -1);
    var allMessagesParsed = undefined;
    if(allMessages && allMessages.length > 0) {
      allMessagesParsed = allMessages.map(function (val) {
        return JSON.parse(val);
      });
    }
    var sendObject = {
      type: 'auth',
      result: 1,
      sessionId: conn.sessionId,
      sessionTimeConnect: conn.sessionTimeConnect,
      participants: participantsMap,
      messages: allMessagesParsed,
      locks: docLock,
      changes: objChangesDocument,
      changesIndex: changesIndex,
      indexUser: conn.user.indexUser,
      jwt: cfgTokenEnableBrowser ? {token: fillJwtByConnection(conn), expires: cfgTokenSessionExpires} : undefined,
      g_cAscSpellCheckUrl: cfgSpellcheckerUrl
    };
    sendData(conn, sendObject);//Or 0 if fails
  }

  function* onMessage(conn, data) {
    var docId = conn.docId;
    var userId = conn.user.id;
    var msg = {docid: docId, message: data.message, time: Date.now(), user: userId, username: conn.user.username};
    var msgStr = JSON.stringify(msg);
    var multi = redisClient.multi([
      ['rpush', redisKeyMessage + docId, msgStr],
      ['expire', redisKeyMessage + docId, cfgExpMessage]
    ]);
    yield utils.promiseRedis(multi, multi.exec);
    logger.info("insert message: docId = %s %s", docId, msgStr);

    var messages = [msg];
    sendDataMessage(conn, messages);
    yield* publish({type: commonDefines.c_oPublishType.message, docId: docId, userId: userId, messages: messages}, docId, userId);
  }

  function* onCursor(conn, data) {
    var docId = conn.docId;
    var userId = conn.user.id;
    var msg = {cursor: data.cursor, time: Date.now(), user: userId, useridoriginal: conn.user.idOriginal};

    logger.info("send cursor: docId = %s %s", docId, msg);

    var messages = [msg];
    yield* publish({type: commonDefines.c_oPublishType.cursor, docId: docId, userId: userId, messages: messages}, docId, userId);
  }

  function* getLock(conn, data, bIsRestore) {
    logger.info("getLock docid: %s", conn.docId);
    var fLock = null;
    switch (conn.editorType) {
      case EditorTypes.document:
        fLock = getLockWord;
        break;
      case EditorTypes.spreadsheet:
        fLock = getLockExcel;
        break;
      case EditorTypes.presentation:
        fLock = getLockPresentation;
        break;
    }
    return fLock ? yield* fLock(conn, data, bIsRestore) : false;
  }

  function* getLockWord(conn, data, bIsRestore) {
    var docId = conn.docId, userId = conn.user.id, arrayBlocks = data.block;
    var i;
    var checkRes = yield* _checkLock(docId, arrayBlocks);
    var documentLocks = checkRes.documentLocks;
    if (checkRes.res) {
      var toCache = [];
      for (i = 0; i < arrayBlocks.length; ++i) {
        var block = arrayBlocks[i];
        var elem = {time: Date.now(), user: userId, block: block, sessionId: conn.sessionId};
        documentLocks[block] = elem;
        toCache.push(JSON.stringify(elem));
      }
      yield* addLocks(docId, toCache);
    } else if (bIsRestore) {
      return false;
    }
    sendData(conn, {type: "getLock", locks: documentLocks});
    yield* publish({type: commonDefines.c_oPublishType.getLock, docId: docId, userId: userId, documentLocks: documentLocks}, docId, userId);
    return true;
  }
  function* getLockExcel(conn, data, bIsRestore) {
    var docId = conn.docId, userId = conn.user.id, arrayBlocks = data.block;
    var i;
    var checkRes = yield* _checkLockExcel(docId, arrayBlocks, userId);
    var documentLocks = checkRes.documentLocks;
    if (checkRes.res) {
      var toCache = [];
      for (i = 0; i < arrayBlocks.length; ++i) {
        var block = arrayBlocks[i];
        var elem = {time: Date.now(), user: userId, block: block, sessionId: conn.sessionId};
        documentLocks.push(elem);
        toCache.push(JSON.stringify(elem));
      }
      yield* addLocks(docId, toCache);
    } else if (bIsRestore) {
      return false;
    }
    sendData(conn, {type: "getLock", locks: documentLocks});
    yield* publish({type: commonDefines.c_oPublishType.getLock, docId: docId, userId: userId, documentLocks: documentLocks}, docId, userId);
    return true;
  }
  function* getLockPresentation(conn, data, bIsRestore) {
    var docId = conn.docId, userId = conn.user.id, arrayBlocks = data.block;
    var i;
    var checkRes = yield* _checkLockPresentation(docId, arrayBlocks, userId);
    var documentLocks = checkRes.documentLocks;
    if (checkRes.res) {
      var toCache = [];
      for (i = 0; i < arrayBlocks.length; ++i) {
        var block = arrayBlocks[i];
        var elem = {time: Date.now(), user: userId, block: block, sessionId: conn.sessionId};
        documentLocks.push(elem);
        toCache.push(JSON.stringify(elem));
      }
      yield* addLocks(docId, toCache);
    } else if (bIsRestore) {
      return false;
    }
    sendData(conn, {type: "getLock", locks: documentLocks});
    yield* publish({type: commonDefines.c_oPublishType.getLock, docId: docId, userId: userId, documentLocks: documentLocks}, docId, userId);
    return true;
  }

  function sendGetLock(participants, documentLocks) {
    _.each(participants, function(participant) {
      sendData(participant, {type: "getLock", locks: documentLocks});
    });
  }

  function* setChangesIndex(docId, index) {
    yield utils.promiseRedis(redisClient, redisClient.setex, redisKeyChangeIndex + docId, cfgExpChangeIndex, index);
  }
  function* saveChanges(conn, data) {
    var docId = conn.docId, userId = conn.user.id;
    logger.info("Start saveChanges docid: %s", docId);

    var puckerIndex = yield* getChangesIndex(docId);

    var deleteIndex = -1;
    if (data.startSaveChanges && null != data.deleteIndex) {
      deleteIndex = data.deleteIndex;
      if (-1 !== deleteIndex) {
        var deleteCount = puckerIndex - deleteIndex;
        if (0 < deleteCount) {
          puckerIndex -= deleteCount;
          yield sqlBase.deleteChangesPromise(docId, deleteIndex);
        } else if (0 > deleteCount) {
          logger.error("Error saveChanges docid: %s ; deleteIndex: %s ; startIndex: %s ; deleteCount: %s", docId, deleteIndex, puckerIndex, deleteCount);
        }
      }
    }
    var startIndex = puckerIndex;

    var newChanges = JSON.parse(data.changes);
    var arrNewDocumentChanges = [];
    logger.info("saveChanges docid: %s ; deleteIndex: %s ; startIndex: %s ; length: %s", docId, deleteIndex, startIndex, newChanges.length);
    if (0 < newChanges.length) {
      var oElement = null;

      for (var i = 0; i < newChanges.length; ++i) {
        oElement = newChanges[i];
        arrNewDocumentChanges.push({docid: docId, change: JSON.stringify(oElement), time: Date.now(),
          user: userId, useridoriginal: conn.user.idOriginal});
      }

      puckerIndex += arrNewDocumentChanges.length;
      yield sqlBase.insertChangesPromise(arrNewDocumentChanges, docId, startIndex, conn.user);
    }
    yield* setChangesIndex(docId, puckerIndex);
    var changesIndex = (-1 === deleteIndex && data.startSaveChanges) ? startIndex : -1;
    if (data.endSaveChanges) {
      if (data.isExcel && false !== data.isCoAuthoring && data.excelAdditionalInfo) {
        var tmpAdditionalInfo = JSON.parse(data.excelAdditionalInfo);
        var oRecalcIndexColumns = _addRecalcIndex(tmpAdditionalInfo["indexCols"]);
        var oRecalcIndexRows = _addRecalcIndex(tmpAdditionalInfo["indexRows"]);
        if (null !== oRecalcIndexColumns || null !== oRecalcIndexRows) {
          var docLock = yield* getAllLocks(docId);
          if (_recalcLockArray(userId, docLock, oRecalcIndexColumns, oRecalcIndexRows)) {
            var toCache = [];
            for (var i = 0; i < docLock.length; ++i) {
              toCache.push(JSON.stringify(docLock[i]));
            }
            yield* addLocks(docId, toCache, true);
          }
        }
      }
      var userLocks = yield* getUserLocks(docId, conn.sessionId);
      var checkEndAuthLockRes = yield* checkEndAuthLock(false, docId, userId);
      if (!checkEndAuthLockRes) {
        var arrLocks = _.map(userLocks, function(e) {
          return {
            block: e.block,
            user: e.user,
            time: Date.now(),
            changes: null
          };
        });
        var changesToSend = arrNewDocumentChanges;
        if(changesToSend.length > cfgPubSubMaxChanges) {
          changesToSend = null;
        }
        yield* publish({type: commonDefines.c_oPublishType.changes, docId: docId, userId: userId,
          changes: changesToSend, startIndex: startIndex, changesIndex: puckerIndex,
          locks: arrLocks, excelAdditionalInfo: data.excelAdditionalInfo}, docId, userId);
      }
      yield* unSaveLock(conn, changesIndex);
      yield utils.promiseRedis(redisClient, redisClient.setex, redisKeyLastSave + docId, cfgExpLastSave, (new Date()).toISOString() + '_' + puckerIndex);

    } else {
      var changesToSend = arrNewDocumentChanges;
      if(changesToSend.length > cfgPubSubMaxChanges) {
        changesToSend = null;
      }
      yield* publish({type: commonDefines.c_oPublishType.changes, docId: docId, userId: userId,
        changes: changesToSend, startIndex: startIndex, changesIndex: puckerIndex,
        locks: [], excelAdditionalInfo: undefined}, docId, userId);
      sendData(conn, {type: 'savePartChanges', changesIndex: changesIndex});
    }
  }
  function* isSaveLock(conn) {
    var isSaveLock = true;
    var exist = yield utils.promiseRedis(redisClient, redisClient.setnx, redisKeySaveLock + conn.docId, conn.user.id);
    if (exist) {
      isSaveLock = false;
      var saveLock = yield utils.promiseRedis(redisClient, redisClient.expire, redisKeySaveLock + conn.docId, cfgExpSaveLock);
    }
    sendData(conn, {type: "saveLock", saveLock: isSaveLock});
  }
  function* unSaveLock(conn, index) {
    var saveLock = yield utils.promiseRedis(redisClient, redisClient.get, redisKeySaveLock + conn.docId);
    if (null === saveLock || conn.user.id == saveLock) {
      yield utils.promiseRedis(redisClient, redisClient.del, redisKeySaveLock + conn.docId);
      sendData(conn, {type: 'unSaveLock', index: index});
    }
  }
  function* getMessages(conn) {
    var allMessages = yield utils.promiseRedis(redisClient, redisClient.lrange, redisKeyMessage + conn.docId, 0, -1);
    var allMessagesParsed = undefined;
    if(allMessages && allMessages.length > 0) {
      allMessagesParsed = allMessages.map(function (val) {
        return JSON.parse(val);
      });
    }
    sendData(conn, {type: "message", messages: allMessagesParsed});
  }

  function* _checkLock(docId, arrayBlocks) {
    var isLock = false;
    var allLocks = yield* getAllLocks(docId);
    var documentLocks = {};
    for(var i = 0 ; i < allLocks.length; ++i) {
      var elem = allLocks[i];
      documentLocks[elem.block] =elem;
    }
    if (arrayBlocks.length > 0) {
      for (var i = 0; i < arrayBlocks.length; ++i) {
        var block = arrayBlocks[i];
        logger.info("getLock id: docId = %s %s", docId, block);
        if (documentLocks.hasOwnProperty(block) && documentLocks[block] !== null) {
          isLock = true;
          break;
        }
      }
    } else {
      isLock = true;
    }
    return {res: !isLock, documentLocks: documentLocks};
  }

  function* _checkLockExcel(docId, arrayBlocks, userId) {
    var documentLock;
    var isLock = false;
    var isExistInArray = false;
    var i, blockRange;
    var documentLocks = yield* getAllLocks(docId);
    var lengthArray = (arrayBlocks) ? arrayBlocks.length : 0;
    for (i = 0; i < lengthArray && false === isLock; ++i) {
      blockRange = arrayBlocks[i];
      for (var keyLockInArray in documentLocks) {
        if (true === isLock) {
          break;
        }
        if (!documentLocks.hasOwnProperty(keyLockInArray)) {
          continue;
        }
        documentLock = documentLocks[keyLockInArray];
        if (documentLock.user === userId &&
          blockRange.sheetId === documentLock.block.sheetId &&
          blockRange.type === c_oAscLockTypeElem.Object &&
          documentLock.block.type === c_oAscLockTypeElem.Object &&
          documentLock.block.rangeOrObjectId === blockRange.rangeOrObjectId) {
          isExistInArray = true;
          break;
        }

        if (c_oAscLockTypeElem.Sheet === blockRange.type &&
          c_oAscLockTypeElem.Sheet === documentLock.block.type) {
          if (documentLock.user === userId) {
            if (blockRange.sheetId === documentLock.block.sheetId) {
              isExistInArray = true;
              break;
            } else {
              continue;
            }
          } else {
            isLock = true;
            break;
          }
        }

        if (documentLock.user === userId || !(documentLock.block) ||
          blockRange.sheetId !== documentLock.block.sheetId) {
          continue;
        }
        isLock = compareExcelBlock(blockRange, documentLock.block);
      }
    }
    if (0 === lengthArray) {
      isLock = true;
    }
    return {res: !isLock && !isExistInArray, documentLocks: documentLocks};
  }

  function* _checkLockPresentation(docId, arrayBlocks, userId) {
    var isLock = false;
    var i, documentLock, blockRange;
    var documentLocks = yield* getAllLocks(docId);
    var lengthArray = (arrayBlocks) ? arrayBlocks.length : 0;
    for (i = 0; i < lengthArray && false === isLock; ++i) {
      blockRange = arrayBlocks[i];
      for (var keyLockInArray in documentLocks) {
        if (true === isLock) {
          break;
        }
        if (!documentLocks.hasOwnProperty(keyLockInArray)) {
          continue;
        }
        documentLock = documentLocks[keyLockInArray];

        if (documentLock.user === userId || !(documentLock.block)) {
          continue;
        }
        isLock = comparePresentationBlock(blockRange, documentLock.block);
      }
    }
    if (0 === lengthArray) {
      isLock = true;
    }
    return {res: !isLock, documentLocks: documentLocks};
  }

  function _checkLicense(conn) {
    return co(function* () {
      try {
        const c_LR = constants.LICENSE_RESULT;
        var licenseType = licenseInfo.type;
        if (constants.PACKAGE_TYPE_OS === licenseInfo.packageType && c_LR.Error === licenseType) {
          licenseType = c_LR.SuccessLimit;

          var count = constants.LICENSE_CONNECTIONS;
          var cursor = '0', sum = 0, scanRes, tmp, length, i, users;
          while (true) {
            scanRes = yield utils.promiseRedis(redisClient, redisClient.scan, cursor, 'MATCH', redisKeyPresenceHash + '*');
            tmp = scanRes[1];
            sum += (length = tmp.length);

            for (i = 0; i < length; ++i) {
              if (sum >= count) {
                licenseType = c_LR.Connections;
                break;
              }

              users = yield utils.promiseRedis(redisClient, redisClient.hlen, tmp[i]);
              sum += users - (0 !== users ? 1 : 0);
            }

            if (sum >= count) {
              licenseType = c_LR.Connections;
              break;
            }

            cursor = scanRes[0];
            if ('0' === cursor) {
              break;
            }
          }
        }

        var rights = constants.RIGHTS.Edit;
        if (config.get('server.edit_singleton')) {
          var docIdParsed = urlParse.exec(conn.url);
          if (docIdParsed && 1 < docIdParsed.length) {
            const participantsMap = yield* getParticipantMap(docIdParsed[1]);
            for (let i = 0; i < participantsMap.length; ++i) {
              const elem = participantsMap[i];
              if (!elem.view) {
                rights = constants.RIGHTS.View;
                break;
              }
            }
          }
        }

        sendData(conn, {
          type: 'license',
          license: {
            type: licenseType,
            light: licenseInfo.light,
            trial: constants.PACKAGE_TYPE_OS === licenseInfo.packageType ? false : licenseInfo.trial,
            rights: rights,
            buildVersion: commonDefines.buildVersion,
            branding: licenseInfo.branding
          }
        });
      } catch (err) {
        logger.error('_checkLicense error:\r\n%s', err.stack);
      }
    });
  }

  sockjs_echo.installHandlers(server, {prefix: '/doc/['+constants.DOC_ID_PATTERN+']*/c', log: function(severity, message) {
    logger.info(message);
  }});
  function pubsubOnMessage(msg) {
    return co(function* () {
      try {
        logger.debug('pubsub message start:%s', msg);
        var data = JSON.parse(msg);
        var participants;
        var participant;
        var objChangesDocument;
        var i;
        switch (data.type) {
          case commonDefines.c_oPublishType.drop:
            for (i = 0; i < data.users.length; ++i) {
              dropUserFromDocument(data.docId, data.users[i], data.description);
            }
            break;
          case commonDefines.c_oPublishType.releaseLock:
            participants = getParticipants(data.docId, true, data.userId, true);
            _.each(participants, function(participant) {
              sendReleaseLock(participant, data.locks);
            });
            break;
          case commonDefines.c_oPublishType.participantsState:
            participants = getParticipants(data.docId, true, data.user.id);
            sendParticipantsState(participants, data);
            break;
          case commonDefines.c_oPublishType.message:
            participants = getParticipants(data.docId, true, data.userId);
            _.each(participants, function(participant) {
              sendDataMessage(participant, data.messages);
            });
            break;
          case commonDefines.c_oPublishType.getLock:
            participants = getParticipants(data.docId, true, data.userId, true);
            sendGetLock(participants, data.documentLocks);
            break;
          case commonDefines.c_oPublishType.changes:
            participants = getParticipants(data.docId, true, data.userId, true);
            if(participants.length > 0) {
              var changes = data.changes;
              if (null == changes) {
                objChangesDocument = yield* getDocumentChanges(data.docId, data.startIndex, data.changesIndex);
                changes = objChangesDocument.arrChanges;
              }
              _.each(participants, function(participant) {
                sendData(participant, {type: 'saveChanges', changes: changes,
                  changesIndex: data.changesIndex, locks: data.locks, excelAdditionalInfo: data.excelAdditionalInfo});
              });
            }
            break;
          case commonDefines.c_oPublishType.auth:
            participants = getParticipants(data.docId, true, data.userId, true);
            if(participants.length > 0) {
              objChangesDocument = yield* getDocumentChanges(data.docId);
              for (i = 0; i < participants.length; ++i) {
                participant = participants[i];
                yield* sendAuthInfo(objChangesDocument.arrChanges, objChangesDocument.getLength(), participant, data.participantsMap);
              }
            }
            break;
          case commonDefines.c_oPublishType.receiveTask:
            var cmd = new commonDefines.InputCommand(data.cmd);
            var output = new canvasService.OutputDataWrap();
            output.fromObject(data.output);
            var outputData = output.getData();

            var docConnectionId = cmd.getDocConnectionId();
            var docId;
            if(docConnectionId){
              docId = docConnectionId;
            } else {
              docId = cmd.getDocId();
            }
            if (cmd.getUserConnectionId()) {
              participants = getParticipantUser(docId, cmd.getUserConnectionId());
            } else {
              participants = getParticipants(docId);
            }
            for (i = 0; i < participants.length; ++i) {
              participant = participants[i];
              if (data.needUrlKey) {
                if (0 == data.needUrlMethod) {
                  outputData.setData(yield storage.getSignedUrls(participant.baseUrl, data.needUrlKey));
                } else if (1 == data.needUrlMethod) {
                  outputData.setData(yield storage.getSignedUrl(participant.baseUrl, data.needUrlKey));
                } else {
                  var contentDisposition = cmd.getInline() ? constants.CONTENT_DISPOSITION_INLINE : constants.CONTENT_DISPOSITION_ATTACHMENT;
                  outputData.setData(yield storage.getSignedUrl(participant.baseUrl, data.needUrlKey, null, cmd.getTitle(), contentDisposition));
                }
              }
              sendData(participant, output);
            }
            break;
          case commonDefines.c_oPublishType.warning:
            participants = getParticipants(data.docId);
            _.each(participants, function(participant) {
              sendDataWarning(participant, data.description);
            });
            break;
          case commonDefines.c_oPublishType.cursor:
            participants = getParticipants(data.docId, true, data.userId);
            _.each(participants, function(participant) {
              sendDataCursor(participant, data.messages);
            });
            break;
          case commonDefines.c_oPublishType.shutdown:
            logger.debug('start shutdown');
            shutdownFlag = true;
            logger.debug('active connections: %d', connections.length);
            var connectionsTmp = connections.slice();
            for (i = 0; i < connectionsTmp.length; ++i) {
              connectionsTmp[i].close(constants.SHUTDOWN_CODE, constants.SHUTDOWN_REASON);
            }
            logger.debug('end shutdown');
            break;
          case commonDefines.c_oPublishType.meta:
            participants = getParticipants(data.docId);
            _.each(participants, function(participant) {
              sendDataMeta(participant, data.meta);
            });
            break;
          default:
            logger.debug('pubsub unknown message type:%s', msg);
        }
      } catch (err) {
        logger.error('pubsub message error:\r\n%s', err.stack);
      }
    });
  }
  function expireDoc() {
    var cronJob = this;
    return co(function* () {
      try {
        var countEdit = 0;
        var countView = 0;
        logger.debug('expireDoc connections.length = %d', connections.length);
        var commands = [];
        var idSet = new Set();
        var nowMs = new Date().getTime();
        var nextMs = cronJob.nextDate();
        var maxMs = Math.max(nowMs + cfgExpSessionCloseCommand, nextMs);
        for (var i = 0; i < connections.length; ++i) {
          var conn = connections[i];
          if (cfgExpSessionAbsolute > 0) {
            if (maxMs - conn.sessionTimeConnect > cfgExpSessionAbsolute && !conn.sessionIsSendWarning) {
              conn.sessionIsSendWarning = true;
              sendDataSession(conn, {
                code: constants.SESSION_ABSOLUTE_CODE,
                reason: constants.SESSION_ABSOLUTE_REASON
              });
            } else if (nowMs - conn.sessionTimeConnect > cfgExpSessionAbsolute) {
              conn.close(constants.SESSION_ABSOLUTE_CODE, constants.SESSION_ABSOLUTE_REASON);
              continue;
            }
          }
          if (cfgExpSessionIdle > 0) {
            if (maxMs - conn.sessionTimeLastAction > cfgExpSessionIdle && !conn.sessionIsSendWarning) {
              conn.sessionIsSendWarning = true;
              sendDataSession(conn, {
                code: constants.SESSION_IDLE_CODE,
                reason: constants.SESSION_IDLE_REASON,
                interval: cfgExpSessionIdle
              });
            } else if (nowMs - conn.sessionTimeLastAction > cfgExpSessionIdle) {
              conn.close(constants.SESSION_IDLE_CODE, constants.SESSION_IDLE_REASON);
              continue;
            }
          }
          if (constants.CONN_CLOSED === conn.readyState) {
            logger.error('expireDoc connection closed docId = %s', conn.docId);
          }
          idSet.add(conn.docId);
          updatePresenceCommandsToArray(commands, conn.docId, conn.user.id, getConnectionInfo(conn));
          if (conn.user && conn.user.view) {
            countView++;
          } else {
            countEdit++;
          }
        }
        var expireAt = new Date().getTime() + cfgExpPresence * 1000;
        idSet.forEach(function(value1, value2, set) {
          commands.push(['zadd', redisKeyDocuments, expireAt, value1]);
        });
        if (commands.length > 0) {
          var multi = redisClient.multi(commands);
          yield utils.promiseRedis(multi, multi.exec);
        }
        if (clientStatsD) {
          clientStatsD.gauge('expireDoc.connections.all', countEdit + countView);
          clientStatsD.gauge('expireDoc.connections.edit', countEdit);
          clientStatsD.gauge('expireDoc.connections.view', countView);
        }
      } catch (err) {
        logger.error('expireDoc error:\r\n%s', err.stack);
      }
    });
  }
  var innerPingJob = function(opt_isStart) {
    if (!opt_isStart) {
      logger.warn('expireDoc restart');
    }
    new cron.CronJob(cfgExpDocumentsCron, expireDoc, innerPingJob, true);
  };
  innerPingJob(true);

  pubsub = new pubsubService();
  pubsub.on('message', pubsubOnMessage);
  pubsub.init(function(err) {
    if (null != err) {
      logger.error('createPubSub error :\r\n%s', err.stack);
    }

    queue = new queueService();
    queue.on('response', canvasService.receiveTask);
    queue.init(true, false, false, true, function(err){
      if (null != err) {
        logger.error('createTaskQueue error :\r\n%s', err.stack);
      }

      callbackFunction();
    });
  });
};
exports.setLicenseInfo = function(data) {
  licenseInfo = data;
};
exports.commandFromServer = function (req, res) {
  return co(function* () {
    var result = commonDefines.c_oAscServerCommandErrors.NoError;
    var docId = 'commandFromServer';
    try {
      var version = undefined;
      var params;
      if (req.body && Buffer.isBuffer(req.body)) {
        params = JSON.parse(req.body.toString('utf8'));
      } else {
        params = req.query;
      }
      if (cfgTokenEnableRequestInbox) {
        result = commonDefines.c_oAscServerCommandErrors.Token;
        var checkJwtRes = checkJwtHeader(docId, req);
        if (checkJwtRes) {
          if (checkJwtRes.decoded) {
            if (!utils.isEmptyObject(checkJwtRes.decoded.payload)) {
              Object.assign(params, checkJwtRes.decoded.payload);
              result = commonDefines.c_oAscServerCommandErrors.NoError;
            } else if (checkJwtRes.decoded.payloadhash) {
              if (checkJwtPayloadHash(docId, checkJwtRes.decoded.payloadhash, req.body, checkJwtRes.token)) {
                result = commonDefines.c_oAscServerCommandErrors.NoError;
              }
            } else if (!utils.isEmptyObject(checkJwtRes.decoded.query)) {
              Object.assign(params, checkJwtRes.decoded.query);
              result = commonDefines.c_oAscServerCommandErrors.NoError;
            }
          } else {
            if (constants.JWT_EXPIRED_CODE == checkJwtRes.code) {
              result = commonDefines.c_oAscServerCommandErrors.TokenExpire;
            }
          }
        }
      }
      docId = params.key;
      if (commonDefines.c_oAscServerCommandErrors.NoError === result && null == docId && 'version' != params.c) {
        result = commonDefines.c_oAscServerCommandErrors.DocumentIdError;
      } else if(commonDefines.c_oAscServerCommandErrors.NoError === result) {
        logger.debug('Start commandFromServer: docId = %s c = %s', docId, params.c);
        switch (params.c) {
          case 'info':
            var selectRes = yield taskResult.select(docId);
            if (selectRes.length > 0) {
              result = yield* bindEvents(docId, params.callback, utils.getBaseUrlByRequest(req), undefined, params.userdata);
            } else {
              result = commonDefines.c_oAscServerCommandErrors.DocumentIdError;
            }
            break;
          case 'drop':
            if (params.userid) {
              yield* publish({type: commonDefines.c_oPublishType.drop, docId: docId, users: [params.userid], description: params.description});
            }
            else if (params.users) {
              var users = (typeof params.users === 'string') ? JSON.parse(params.users) : params.users;
              yield* dropUsersFromDocument(docId, users);
            } else {
              result = commonDefines.c_oAscServerCommandErrors.UnknownCommand;
            }
            break;
          case 'saved':
            if ('1' !== params.status) {
              yield utils.promiseRedis(redisClient, redisClient.setex, redisKeySaved + docId, cfgExpSaved, params.status);
              logger.error('saved corrupted id = %s status = %s conv = %s', docId, params.status, params.conv);
            } else {
              logger.info('saved id = %s status = %s conv = %s', docId, params.status, params.conv);
            }
            break;
          case 'forcesave':
            var lastSave = null;
            if (!shutdownFlag) {
              lastSave = yield utils.promiseRedis(redisClient, redisClient.get, redisKeyLastSave + docId);
            }
            if (lastSave) {
              var baseUrl = utils.getBaseUrlByRequest(req);
              var multi = redisClient.multi([
                ['hsetnx', redisKeyForceSave + docId, lastSave, ""],
                ['expire', redisKeyForceSave + docId, cfgExpForceSave]
              ]);
              var execRes = yield utils.promiseRedis(multi, multi.exec);
              if (0 == execRes[0]) {
                result = commonDefines.c_oAscServerCommandErrors.NotModify;
              } else {
                var status = yield* converterService.convertFromChanges(docId, baseUrl, lastSave, params.userdata);
                if (constants.NO_ERROR !== status.err) {
                  result = commonDefines.c_oAscServerCommandErrors.UnknownError;
                }
              }
            } else {
              result = commonDefines.c_oAscServerCommandErrors.NotModify;
            }
            break;
          case 'meta':
            if (params.meta) {
              yield* publish({type: commonDefines.c_oPublishType.meta, docId: docId, meta: params.meta});
            } else {
              result = commonDefines.c_oAscServerCommandErrors.UnknownError;
            }
            break;
          case 'version':
              version = commonDefines.buildVersion + '.' + commonDefines.buildNumber;
            break;
          default:
            result = commonDefines.c_oAscServerCommandErrors.UnknownCommand;
            break;
        }
      }
    } catch (err) {
      result = commonDefines.c_oAscServerCommandErrors.UnknownError;
      logger.error('Error commandFromServer: docId = %s\r\n%s', docId, err.stack);
    } finally {
      var output = JSON.stringify({'key': docId, 'error': result, 'version': version});
      logger.debug('End commandFromServer: docId = %s %s', docId, output);
      var outputBuffer = new Buffer(output, 'utf8');
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Length', outputBuffer.length);
      res.send(outputBuffer);
    }
  });
};
