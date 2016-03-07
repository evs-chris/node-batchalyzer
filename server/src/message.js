'use strict';

module.exports = function(cfg, log) {
  // throws out a message regardless of predecessors
  function single(msg, details) {
    return doMessage(msg, details, false);
  }

  // checks for an existing unhandled message to update
  // creates a new one if none exist
  function persistent(msg, details) {
    return doMessage(msg, details, true);
  }

  function doMessage(msg, details, check) {
    let m;
    let orig = msg;

    if (!check) {
      delete msg.id;
      delete msg.handle;
    }

    if (!m) {
      m = {
        statId: (details.stat || {}).id || details.statId,
        orderId: (details.order || {}).id || details.orderId,
        agentId: (details.agent || {}).id || details.agentId,
        audit: []
      };
    } else {
      orig = m.message;
    }

    m.message = msg;
    if ('extra' in details) m.extra = details.extra;
    if (details.deferUntil) m.deferredUntil = details.deferUntil;

    let status = 0;
    if (m.details.resolve) status = 3;
    else if (m.details.deferUntil) status = 2;
    else if (m.details.ack) status = 1;
    m.status = status;

    if (m.status !== status || msg !== orig) m.audit.push({
      who: (details.user || {}).name || details.username || '<system>',
      when: new Date().toISOString(),
      status,
      previous: orig
    });
  }

  return {
    single, persistent
  };
};
