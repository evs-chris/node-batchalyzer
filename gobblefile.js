var gobble = require('gobble');

var babelOpts = {
  blacklist: ['regenerator'],
  sourceMap: false
};

var serverSrc = gobble('server/src').transform('babel', babelOpts);
var agentSrc = gobble('agent/src').transform('babel', babelOpts);
var dataSrc = gobble('data-pg/src').transform('babel', babelOpts);
var migrations = gobble('data-pg/migrations').moveTo('data-pg/migrations');

var res = gobble([serverSrc.moveTo('server'), agentSrc.moveTo('agent'), dataSrc.moveTo('data-pg'), migrations]);

module.exports = res;
