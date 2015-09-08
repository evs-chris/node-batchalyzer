var gobble = require('gobble');

var babelOpts = {
  blacklist: ['regenerator'],
  sourceMap: false
};

var serverSrc = gobble('server/src').transform('babel', babelOpts);
var agentSrc = gobble('agent/src').transform('babel', babelOpts);
var dataSrc = gobble('data-pg/src').transform('babel', babelOpts);
var migrations = gobble('data-pg/migrations').moveTo('data-pg/migrations');
var apiSrc = gobble('api/src').transform('babel', babelOpts);
var apiHtml = gobble('api/client').moveTo('api/client');
var apiClient = gobble('api/client/src').transform('babel', babelOpts).moveTo('api/client/js');

var res = gobble([serverSrc.moveTo('server'), agentSrc.moveTo('agent'), dataSrc.moveTo('data-pg'), migrations, apiSrc.moveTo('api'), apiHtml, apiClient]);

module.exports = res;
