# batchalyzer

batchalyzer is a sort of combination of CRON and Nagios with more advanced job handling.

## Why

Well, for lots of reasons. Here are a few:

1. CRON is fine for running relatively simple things, but making sure that things don't run long or consume too many of the wrong resources is more than challenging. Also, there is no builtin handling of return codes, failure notification, or collection of output.
2. Nagios and it's friends, cousins, and children are pretty good, but the arcane config and interface don't really tickle my fancy. I'm also not a huge fan on having stats collected over SSH, though you could argue that running an agent that can do the same things posses just as many if not more risks.
3. Job management and stat collection feel like natural bedfellows to me. You want notification for hosts with stat problems (disk full, out of memory, seems to have rebooted) and job failures.
4. Sometimes you want to track stats on jobs too.
5. Some types of jobs, like sending content to a remote host over HTTP or FTP require some sort of rate limiting that is really hard to accomplish with CRON and friends.

## Why Not

Node is a little heavy for stat collection and job management. It does have a much lower barrier to entry than C, Java, and the like though. It is also single threaded as far as the schedule processing (determining which jobs should be fired) is concerned, so if there is an enormous schedule it could lag.

An agent that runs whatever the server tells it to could be a security issue if the agent has bugs or is not configured properly. Misconfiguration will always be a danger, but arbitrary command execution will hopefully be covered by black and/or white lists for the various types of commands supported.

You have to install and maintain an agent on agent hosts. I still prefer it to having a special SSH account with special scripts for calling in though.

## Architecture

Batchalyzer has a few different components, but the main pieces are the server and the agent.

### Server

The server is responsible for:

1. Loading scheduled jobs on the days that they can be run
2. Managing inter-job dependencies (conditions)
3. Managing resource acquisition and release
4. Sending eligible jobs to an agent to execute
5. Loading stats and firing collection requests to agents
6. Posting messages for stat and agent issues and job failures or alerts
7. Maintaing a socket server for agent connections
8. Authenticating connecting agents

#### Data Access

Data access is designed to be as platform agnostic as possible. The only DAO available now is for PostgreSQL, but it is designed to be swappable for anything that can return the requisite objects with ids via Promises. The next implementation will probably be a JSON file store so that batchalyzer can be deployed with no dependencies beyond Node.

#### API

To avoid adding client auth to the server, there is an all-access-allowed API client that can manage what its clients can and cannot do. The API clients/servers themselves have no restrictions on their actions.

### Agent

The agents are responsible for:

1. Connecting to the server
2. Responding to stat collection requests
3. Running jobs and sending back output
4. Buffering and resending messages if it gets disconnected

An agent has a name that is used for job targeting. It may also be a member of any number of groups that may also be used for job targeting.

#### Stats

Stats can be builtins, like memory, uptime, and load or external programs or node scripts. External node scripts are forked and are expected to send back their result using `process.send()`. External programs are expected to have a specifically formatted last line, similar to Nagios plugins. Unlike Nagios plugins, batchalyzer plugins are meant to collect a single stat at a time.

Each type of stat is optional for an agent, meaning it can be configured not to run any of builtin, shell, or fork stats.

#### Jobs

Like stats, jobs can be either external programs or node scripts. External program can be configured by having the job include environment variables. External node scripts receive their configuration as a message from the agent process along with having their environment set. stdout and stderr are collected for jobs separately and send back to the server in chunks.

Like stats, both types of jobs are optional for an agent. An agent can also be configured not to run jobs at all.

Jobs can be targeted to a specific agent, a group of agents, a specific group, or a group of groups. They can also be set to run at a specific time (one-off), at an interval, using CRON-like variables, or a combination of CRON-ish and interval.

Jobs can be configured to require certain conditions before they can run. The can also be configured to post conditions when they complete. This can be used to set up inter-job dependencies so that job execution order is guaranteed. For instance, an aging job may require a backup job to be complete before it takes off.

Jobs can also be configured to require resources. A resource can be either a fixed pool, like 'Server 3 has 4 processors', or a rate limit, like 'we can only connect to google.com 10 times a minute'. Pooled resources are acquired 1 or more at a time. Rate-limited resources are tracked one at a time with a number per minute limit.

## TODO

* Split the project up into separate repos
* File triggered jobs - right now, only time can trigger a job
* Central script deployment - agents that want to should be able to pull scripts from the server instead of having to have them already available locally
* JSON file store
* Fix all of the myriad TODOs in the code base
