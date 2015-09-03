module.exports = function(cfg, log) {
  function initAgent(context, agent) {
    // TODO: set up resources based on server config, agent config, agent info
    return Promise.resolve(true);
  }

  function newAgentInfo(context, agent, info) {
    // TODO: upate resources based on info? if there wasn't manual config?
    return Promise.resolve(true);
  }

  return {
    initAgent, newAgentInfo
  };
};
