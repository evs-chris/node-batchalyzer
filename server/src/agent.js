'use strict';

// TODO: warn if agent ip changes?

module.exports = function(cfg, log) {
  function initAgent(context, agent) {
    // TODO: set up resources based on server config, agent config, agent info
    return Promise.resolve(true);
  }

  function newAgentInfo(context, agent, info) {
    const { dao } = context;
    // TODO: upate resources based on info? if there wasn't manual config?
    agent.info = info;
    agent.location = agent.socket.upgradeReq.headers['x-forwarded-for'] || agent.socket.upgradeReq.connection.remoteAddress;
    return dao.agentInfo(agent, info, agent.location);
  }

  return {
    initAgent, newAgentInfo
  };
};
