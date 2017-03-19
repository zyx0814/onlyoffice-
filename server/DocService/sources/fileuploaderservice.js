/*
 * (c) Copyright Ascensio System Limited 2010-2017. All rights reserved
 *
 * http://www.teamlab.com 
 *
 * Version: 4.2.10 (build:10)
 */


var multiparty = require('multiparty');
var co = require('co');
var jwt = require('jsonwebtoken');
var taskResult = require('./taskresult');
var docsCoServer = require('./DocsCoServer');
var utils = require('./../../Common/sources/utils');
var constants = require('./../../Common/sources/constants');
var storageBase = require('./../../Common/sources/storage-base');
var formatChecker = require('./../../Common/sources/formatchecker');
var logger = require('./../../Common/sources/logger');
var config = require('config');
var configServer = config.get('services.CoAuthoring.server');
var configUtils = config.get('services.CoAuthoring.utils');

var cfgImageSize = configServer.get('limits_image_size');
var cfgTypesUpload = configUtils.get('limits_image_types_upload');
var cfgTokenEnableBrowser = config.get('services.CoAuthoring.token.enable.browser');
var cfgTokenEnableRequestInbox = config.get('services.CoAuthoring.token.enable.request.inbox');

exports.uploadTempFile = function(req, res) {
  return co(function* () {
    var docId = 'null';
    try {
      docId = req.query.key;
      logger.debug('Start uploadTempFile: docId = %s', docId);
      if (cfgTokenEnableRequestInbox) {
        var authError = constants.VKEY;
        var checkJwtRes = docsCoServer.checkJwtHeader(docId, req);
        if (checkJwtRes) {
          if (checkJwtRes.decoded) {
            authError = constants.NO_ERROR;
            if (checkJwtRes.decoded.query && checkJwtRes.decoded.query.key) {
              docId = checkJwtRes.decoded.query.key;
            }
            if (checkJwtRes.decoded.payloadhash &&
              !docsCoServer.checkJwtPayloadHash(docId, checkJwtRes.decoded.payloadhash, req.body, checkJwtRes.token)) {
              authError = constants.VKEY;
            }
          } else {
            if (constants.JWT_EXPIRED_CODE == checkJwtRes.code) {
              authError = constants.VKEY_KEY_EXPIRE;
            }
          }
        }
        if (authError !== constants.NO_ERROR) {
          utils.fillXmlResponse(res, undefined, authError);
          return;
        }
      }

      if (docId && req.body && Buffer.isBuffer(req.body)) {
        var task = yield* taskResult.addRandomKeyTask(docId);
        var strPath = task.key + '/' + docId + '.tmp';
        yield storageBase.putObject(strPath, req.body, req.body.length);
        var url = yield storageBase.getSignedUrl(utils.getBaseUrlByRequest(req), strPath);
        utils.fillXmlResponse(res, url, constants.NO_ERROR);
      } else {
        utils.fillXmlResponse(res, undefined, constants.UNKNOWN);
      }
      logger.debug('End uploadTempFile: docId = %s', docId);
    }
    catch (e) {
      logger.error('Error uploadTempFile: docId = %s\r\n%s', docId, e.stack);
      utils.fillXmlResponse(res, undefined, constants.UNKNOWN);
    }
  });
};
function checkJwtUpload(docId, errorName, token){
  var res = {err: true, docId: null, userid: null};
  var checkJwtRes = docsCoServer.checkJwt(docId, token, true);
  if (checkJwtRes.decoded) {
    var doc = checkJwtRes.decoded.document;
    var edit = checkJwtRes.decoded.editorConfig;
    if (!edit.ds_view && !edit.ds_isCloseCoAuthoring) {
      res.err = false;
      res.docId = doc.key;
      if (edit.user) {
        res.userid = edit.user.id;
      }
    } else {
      logger.error('Error %s jwt: docId = %s\r\n%s', errorName, docId, 'access deny');
    }
  } else {
    logger.error('Error %s jwt: docId = %s\r\n%s', errorName, docId, checkJwtRes.description);
  }
  return res;
}
exports.uploadImageFileOld = function(req, res) {
  var docId = req.params.docid;
  logger.debug('Start uploadImageFileOld: docId = %s', docId);
  var userid = req.params.userid;
  if (cfgTokenEnableBrowser) {
    var checkJwtRes = checkJwtUpload(docId, 'uploadImageFileOld', req.params.jwt);
    if(!checkJwtRes.err){
      docId = checkJwtRes.docId || docId;
      userid = checkJwtRes.userid || userid;
    } else {
      res.sendStatus(400);
      return;
    }
  }
  var index = parseInt(req.params.index);
  var listImages = [];
  if (docId && index) {
    var isError = false;
    var form = new multiparty.Form();
    form.on('error', function(err) {
      logger.error('Error parsing form: docId = %s\r\n%s', docId, err.toString());
      res.sendStatus(400);
    });
    form.on('part', function(part) {
      if (!part.filename) {
        part.resume();
      }
      if (part.filename) {
        if (part.byteCount > cfgImageSize) {
          isError = true;
        }
        if (isError) {
          part.resume();
        } else {
          var strImageName = utils.crc32(userid).toString(16) + '_image' + (parseInt(index) + listImages.length);
          var strPath = docId + '/media/' + strImageName + '.jpg';
          listImages.push(strPath);
          utils.stream2Buffer(part).then(function(buffer) {
            return storageBase.putObject(strPath, buffer, buffer.length);
          }).then(function() {
            part.resume();
          }).catch(function(err) {
            logger.error('Upload putObject: docId = %s\r\n%s', docId, err.stack);
            isError = true;
            part.resume();
          });
        }
      }
      part.on('error', function(err) {
        logger.error('Error parsing form part: docId = %s\r\n%s', docId, err.toString());
      });
    });
    form.on('close', function() {
      if (isError) {
        res.sendStatus(400);
      } else {
        storageBase.getSignedUrlsByArray(utils.getBaseUrlByRequest(req), listImages, docId).then(function(urls) {
            var outputData = {'type': 0, 'error': constants.NO_ERROR, 'urls': urls, 'input': req.query};
            var output = '<html><head><script type="text/javascript">function load(){ parent.postMessage("';
            output += JSON.stringify(outputData).replace(/"/g, '\\"');
            output += '", "*"); }</script></head><body onload="load()"></body></html>';
            res.send(output);
            logger.debug('End uploadImageFileOld: docId = %s %s', docId, output);
          }
        ).catch(function(err) {
            res.sendStatus(400);
            logger.error('upload getSignedUrlsByArray: docId = %s\r\n%s', docId, err.stack);
          });
      }
    });
    form.parse(req);
  } else {
    logger.debug('Error params uploadImageFileOld: docId = %s', docId);
    res.sendStatus(400);
  }
};
exports.uploadImageFile = function(req, res) {
  return co(function* () {
    var isError = true;
    var docId = 'null';
    try {
      docId = req.params.docid;
      var userid = req.params.userid;
      logger.debug('Start uploadImageFile: docId = %s', docId);

      var isValidJwt = true;
      if (cfgTokenEnableBrowser) {
        var checkJwtRes = checkJwtUpload(docId, 'uploadImageFile', req.params.jwt);
        if (!checkJwtRes.err) {
          docId = checkJwtRes.docId || docId;
          userid = checkJwtRes.userid || userid;
        } else {
          isValidJwt = false;
        }
      }

      var index = parseInt(req.params.index);
      if (isValidJwt && docId && req.body && Buffer.isBuffer(req.body)) {
        var buffer = req.body;
        var format = formatChecker.getImageFormat(buffer);
        var formatStr = formatChecker.getStringFromFormat(format);
        var supportedFormats = cfgTypesUpload || 'jpg';
        if (formatStr && -1 !== supportedFormats.indexOf(formatStr) && buffer.length <= cfgImageSize) {
          var strImageName = utils.crc32(userid).toString(16) + '_image' + index;
          var strPathRel = 'media/' + strImageName + '.' + formatStr;
          var strPath = docId + '/' + strPathRel;
          yield storageBase.putObject(strPath, buffer, buffer.length);
          var output = {};
          output[strPathRel] = yield storageBase.getSignedUrl(utils.getBaseUrlByRequest(req), strPath);
          res.send(JSON.stringify(output));
          isError = false;
        }
      }
      logger.debug('End uploadImageFile: isError = %d docId = %s', isError, docId);
    } catch (e) {
      logger.error('Error uploadImageFile: docId = %s\r\n%s', docId, e.stack);
    } finally {
      if (isError) {
        res.sendStatus(400);
      }
    }
  });
};
