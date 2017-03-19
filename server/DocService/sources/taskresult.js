/*
 * (c) Copyright Ascensio System Limited 2010-2017. All rights reserved
 *
 * http://www.teamlab.com 
 *
 * Version: 4.2.10 (build:10)
 */


var sqlBase = require('./baseConnector');
var logger = require('./../../Common/sources/logger');
var utils = require('./../../Common/sources/utils');
var constants = require('./../../Common/sources/constants');

var RANDOM_KEY_MAX = 10000;

var FileStatus = {
  None: 0,
  Ok: 1,
  WaitQueue: 2,
  NeedParams: 3,
  Convert: 4,
  Err: 5,
  ErrToReload: 6,
  SaveVersion: 7,
  UpdateVersion: 8,
  NeedPassword: 9
};

function TaskResultData() {
  this.key = null;
  this.status = null;
  this.statusInfo = null;
  this.lastOpenDate = null;
  this.title = null;
  this.userIndex = null;
  this.changeId = null;
}
TaskResultData.prototype.completeDefaults = function() {
  if (!this.key) {
    this.key = '';
  }
  if (!this.status) {
    this.status = FileStatus.None;
  }
  if (!this.statusInfo) {
    this.statusInfo = constants.NO_ERROR;
  }
  if (!this.lastOpenDate) {
    this.lastOpenDate = new Date();
  }
  if (!this.title) {
    this.title = '';
  }
  if (!this.userIndex) {
    this.userIndex = 1;
  }
  if (!this.changeId) {
    this.changeId = 0;
  }
};

function upsert(task, opt_updateUserIndex) {
  return sqlBase.baseConnector.upsert(task, opt_updateUserIndex);
}

function getSelectString(docId) {
  return 'SELECT * FROM task_result WHERE id=' + sqlBase.baseConnector.sqlEscape(docId) + ';';
}

function select(docId) {
  return new Promise(function(resolve, reject) {
    var sqlCommand = getSelectString(docId);
    sqlBase.baseConnector.sqlQuery(sqlCommand, function(error, result) {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}
function toUpdateArray(task, updateTime) {
  var res = [];
  if (null != task.status) {
    res.push('status=' + sqlBase.baseConnector.sqlEscape(task.status));
  }
  if (null != task.statusInfo) {
    res.push('status_info=' + sqlBase.baseConnector.sqlEscape(task.statusInfo));
  }
  if (updateTime) {
    res.push('last_open_date=' + sqlBase.baseConnector.sqlEscape(sqlBase.getDateTime(new Date())));
  }
  if (null != task.title) {
    res.push('title=' + sqlBase.baseConnector.sqlEscape(task.title));
  }
  if (null != task.indexUser) {
    res.push('user_index=' + sqlBase.baseConnector.sqlEscape(task.indexUser));
  }
  if (null != task.changeId) {
    res.push('change_id=' + sqlBase.baseConnector.sqlEscape(task.changeId));
  }
  return res;
}
function getUpdateString(task) {
  var commandArgEsc = toUpdateArray(task, true);
  return 'UPDATE task_result SET ' + commandArgEsc.join(', ') +
    ' WHERE id=' + sqlBase.baseConnector.sqlEscape(task.key) + ';';
}

function update(task) {
  return new Promise(function(resolve, reject) {
    var sqlCommand = getUpdateString(task);
    sqlBase.baseConnector.sqlQuery(sqlCommand, function(error, result) {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}
function getUpdateIfString(task, mask) {
  var commandArgEsc = toUpdateArray(task, true);
  var commandArgEscMask = toUpdateArray(mask);
  commandArgEscMask.push('id=' + sqlBase.baseConnector.sqlEscape(mask.key));
  return 'UPDATE task_result SET ' + commandArgEsc.join(', ') +
    ' WHERE ' + commandArgEscMask.join(' AND ') + ';';
}

function updateIf(task, mask) {
  return new Promise(function(resolve, reject) {
    var sqlCommand = getUpdateIfString(task, mask);
    sqlBase.baseConnector.sqlQuery(sqlCommand, function(error, result) {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}

function getInsertString(task) {
  var dateNow = sqlBase.getDateTime(new Date());
  task.completeDefaults();
  var commandArg = [task.key, task.status, task.statusInfo, dateNow, task.title, task.userIndex, task.changeId];
  var commandArgEsc = commandArg.map(function(curVal) {
    return sqlBase.baseConnector.sqlEscape(curVal)
  });
  return 'INSERT INTO task_result ( id, status, status_info, last_open_date, title, user_index, change_id) VALUES (' +
    commandArgEsc.join(', ') + ');';
}
function addRandomKey(task) {
  return new Promise(function(resolve, reject) {
    task.key = task.key + '_' + Math.round(Math.random() * RANDOM_KEY_MAX);
    var sqlCommand = getInsertString(task);
    sqlBase.baseConnector.sqlQuery(sqlCommand, function(error, result) {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}
function* addRandomKeyTask(key) {
  var task = new TaskResultData();
  task.key = key;
  task.status = FileStatus.WaitQueue;
  var nTryCount = RANDOM_KEY_MAX;
  var addRes = null;
  while (nTryCount-- > 0) {
    try {
      addRes = yield addRandomKey(task);
    } catch (e) {
      addRes = null;
    }
    if (addRes && addRes.affectedRows > 0) {
      break;
    }
  }
  if (addRes && addRes.affectedRows > 0) {
    return task;
  } else {
    throw new Error('addRandomKeyTask Error');
  }
}

function getRemoveString(docId) {
  return 'DELETE FROM task_result WHERE id=' + sqlBase.baseConnector.sqlEscape(docId) + ';';
}
function remove(docId) {
  return new Promise(function(resolve, reject) {
    var sqlCommand = getRemoveString(docId);
    sqlBase.baseConnector.sqlQuery(sqlCommand, function(error, result) {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}
function getExpiredString(maxCount, expireSeconds) {
  var expireDate = new Date();
  utils.addSeconds(expireDate, -expireSeconds);
  var expireDateStr = sqlBase.baseConnector.sqlEscape(sqlBase.getDateTime(expireDate));
  return 'SELECT * FROM task_result WHERE last_open_date <= ' + expireDateStr +
    ' AND NOT EXISTS(SELECT id FROM doc_changes WHERE doc_changes.id = task_result.id LIMIT 1) LIMIT ' + maxCount + ';';
}
function getExpired(maxCount, expireSeconds) {
  return new Promise(function(resolve, reject) {
    var sqlCommand = getExpiredString(maxCount, expireSeconds);
    sqlBase.baseConnector.sqlQuery(sqlCommand, function(error, result) {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}

exports.FileStatus = FileStatus;
exports.TaskResultData = TaskResultData;
exports.upsert = upsert;
exports.select = select;
exports.update = update;
exports.updateIf = updateIf;
exports.addRandomKeyTask = addRandomKeyTask;
exports.remove = remove;
exports.getExpired = getExpired;
