/*
 * (c) Copyright Ascensio System Limited 2010-2017. All rights reserved
 *
 * http://www.teamlab.com 
 *
 * Version: 4.2.10 (build:10)
 */


'use strict';
var config = require('config');
var events = require('events');
var util = require('util');
var co = require('co');
var utils = require('./utils');
var constants = require('./constants');
var rabbitMQCore = require('./rabbitMQCore');

var cfgVisibilityTimeout = config.get('queue.visibilityTimeout');
var cfgQueueRetentionPeriod = config.get('queue.retentionPeriod');
var cfgRabbitQueueConvertTask = config.get('rabbitmq.queueconverttask');
var cfgRabbitQueueConvertResponse = config.get('rabbitmq.queueconvertresponse');

function init(taskqueue, isAddTask, isAddResponse, isAddTaskReceive, isAddResponseReceive, callback) {
  return co(function* () {
    var e = null;
    try {
      var conn = yield rabbitMQCore.connetPromise(function() {
        clear(taskqueue);
        if (!taskqueue.isClose) {
          init(taskqueue, isAddTask, isAddResponse, isAddTaskReceive, isAddResponseReceive, null);
        }
      });
      taskqueue.connection = conn;
      var bAssertTaskQueue = false;
      var optionsTaskQueue = {
        durable: true,
        arguments: {'x-max-priority': constants.QUEUE_PRIORITY_HIGH, 'x-message-ttl': cfgQueueRetentionPeriod * 1000}
      };
      if (isAddTask) {
        taskqueue.channelConvertTask = yield rabbitMQCore.createConfirmChannelPromise(conn);
        yield rabbitMQCore.assertQueuePromise(taskqueue.channelConvertTask, cfgRabbitQueueConvertTask,
          optionsTaskQueue);
        bAssertTaskQueue = true;
      }
      var bAssertResponseQueue = false;
      var optionsResponseQueue = {durable: true};
      if (isAddResponse) {
        taskqueue.channelConvertResponse = yield rabbitMQCore.createConfirmChannelPromise(conn);
        yield rabbitMQCore.assertQueuePromise(taskqueue.channelConvertResponse, cfgRabbitQueueConvertResponse,
          optionsResponseQueue);
        bAssertResponseQueue = true;
      }
      var optionsReceive = {noAck: false};
      if (isAddTaskReceive) {
        taskqueue.channelConvertTaskReceive = yield rabbitMQCore.createChannelPromise(conn);
        taskqueue.channelConvertTaskReceive.prefetch(1);
        if (!bAssertTaskQueue) {
          yield rabbitMQCore.assertQueuePromise(taskqueue.channelConvertTaskReceive, cfgRabbitQueueConvertTask,
            optionsTaskQueue);
        }
        yield rabbitMQCore.consumePromise(taskqueue.channelConvertTaskReceive, cfgRabbitQueueConvertTask,
          function (message) {
            if (message) {
              taskqueue.emit('task', message.content.toString(), message);
            }
          }, optionsReceive);
      }
      if (isAddResponseReceive) {
        taskqueue.channelConvertResponseReceive = yield rabbitMQCore.createChannelPromise(conn);
        if (!bAssertResponseQueue) {
          yield rabbitMQCore.assertQueuePromise(taskqueue.channelConvertResponseReceive, cfgRabbitQueueConvertResponse,
            optionsResponseQueue);
        }
        yield rabbitMQCore.consumePromise(taskqueue.channelConvertResponseReceive, cfgRabbitQueueConvertResponse,
          function (message) {
            if (message) {
              taskqueue.emit('response', message.content.toString(), message);
            }
          }, optionsReceive);
      }
      repeat(taskqueue);
    } catch (err) {
      e = err;
    }
    if (callback) {
      callback(e);
    }
  });
}
function clear(taskqueue) {
  taskqueue.channelConvertTask = null;
  taskqueue.channelConvertTaskReceive = null;
  taskqueue.channelConvertResponse = null;
  taskqueue.channelConvertResponseReceive = null;
}
function repeat(taskqueue) {
  for (var i = 0; i < taskqueue.addTaskStore.length; ++i) {
    var elem = taskqueue.addTaskStore[i];
    addTask(taskqueue, elem.task, elem.priority, function () {});
  }
  taskqueue.addTaskStore.length = 0;
}
function addTask(taskqueue, content, priority, callback) {
  var options = {persistent: true, priority: priority};
  taskqueue.channelConvertTask.sendToQueue(cfgRabbitQueueConvertTask, content, options, callback);
}
function addResponse(taskqueue, content, callback) {
  var options = {persistent: true};
  taskqueue.channelConvertResponse.sendToQueue(cfgRabbitQueueConvertResponse, content, options, callback);
}
function removeTask(taskqueue, data) {
  taskqueue.channelConvertTaskReceive.ack(data);
}
function removeResponse(taskqueue, data) {
  taskqueue.channelConvertResponseReceive.ack(data);
}

function TaskQueueRabbitMQ() {
  this.isClose = false;
  this.connection = null;
  this.channelConvertTask = null;
  this.channelConvertTaskReceive = null;
  this.channelConvertResponse = null;
  this.channelConvertResponseReceive = null;
  this.addTaskStore = [];
}
util.inherits(TaskQueueRabbitMQ, events.EventEmitter);
TaskQueueRabbitMQ.prototype.init = function (isAddTask, isAddResponse, isAddTaskReceive, isAddResponseReceive, callback) {
  init(this, isAddTask, isAddResponse, isAddTaskReceive, isAddResponseReceive, callback);
};
TaskQueueRabbitMQ.prototype.initPromise = function(isAddTask, isAddResponse, isAddTaskReceive, isAddResponseReceive) {
  var t = this;
  return new Promise(function(resolve, reject) {
    init(t, isAddTask, isAddResponse, isAddTaskReceive, isAddResponseReceive, function(err) {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
};
TaskQueueRabbitMQ.prototype.addTask = function (task, priority) {
  var t = this;
  return new Promise(function (resolve, reject) {
    task.setVisibilityTimeout(cfgVisibilityTimeout);
    var content = new Buffer(JSON.stringify(task));
    if (null != t.channelConvertTask) {
      addTask(t, content, priority, function (err, ok) {
        if (null != err) {
          reject(err);
        } else {
          resolve();
        }
      });
    } else {
      t.addTaskStore.push({task: content, priority: priority});
      resolve();
    }
  });
};
TaskQueueRabbitMQ.prototype.addResponse = function (task) {
  var t = this;
  return new Promise(function (resolve, reject) {
    var content = new Buffer(JSON.stringify(task));
    if (null != t.channelConvertResponse) {
      addResponse(t, content, function (err, ok) {
        if (null != err) {
          reject(err);
        } else {
          resolve();
        }
      });
    } else {
      resolve();
    }
  });
};
TaskQueueRabbitMQ.prototype.removeTask = function (data) {
  var t = this;
  return new Promise(function (resolve, reject) {
    if (null != t.channelConvertTaskReceive) {
      removeTask(t, data);
    }
    resolve();
  });
};
TaskQueueRabbitMQ.prototype.removeResponse = function (data) {
  var t = this;
  return new Promise(function (resolve, reject) {
    if (null != t.channelConvertResponseReceive) {
      removeResponse(t, data);
    }
    resolve();
  });
};
TaskQueueRabbitMQ.prototype.close = function () {
  var t = this;
  this.isClose = true;
  return new Promise(function(resolve, reject) {
    t.connection.close(function(err) {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
};

module.exports = TaskQueueRabbitMQ;
