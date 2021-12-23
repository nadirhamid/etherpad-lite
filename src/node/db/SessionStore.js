'use strict';

const DB = require('./DB');
const Store = require('express-session').Store;
const log4js = require('log4js');
const util = require('util');

const logger = log4js.getLogger('SessionStore');

class SessionStore extends Store {
  /**
   * @param {?number} [refresh] - How often (in milliseconds) `touch()` will update a session's
   *     database record with the cookie's latest expiration time. If the difference between the
   *     value saved in the database and the actual value is greater than this amount, the database
   *     record will be updated to reflect the actual value. Use this to avoid continual database
   *     writes caused by express-session's rolling=true feature (see
   *     https://github.com/expressjs/session#rolling). A good value is high enough to keep query
   *     rate low but low enough to avoid annoying premature logouts (session invalidation) if
   *     Etherpad is restarted. Use `null` to prevent `touch()` from ever updating the record.
   *     Ignored if the cookie does not expire.
   */
  constructor(refresh = null) {
    super();
    this._refresh = refresh;
    // Maps session ID to an object with the following properties:
    //   - `exp`: When the session expires, in ms since epoch (not a Date object).
    //   - `timeout`: Timeout ID for a timeout that will clean up the database record.
    this._expirations = new Map();
  }

  shutdown() {
    for (const {timeout} of this._expirations.values()) clearTimeout(timeout);
  }

  _scheduleCleanup(sess) {
    const {cookie: {expires} = {}, id} = sess;
    clearTimeout((this._expirations.get(id) || {}).timeout);
    if (expires) {
      const exp = new Date(expires).getTime();
      // Use this._get(), not this._destroy(), to destroy the DB record for the expired session.
      // This is done in case multiple Etherpad instances are sharing the same database and users
      // are bouncing between the instances. By using this._get(), this instance will query the DB
      // for the latest expiration time written by any of the instances, ensuring that the record
      // isn't prematurely deleted if the expiration time was updated by a different Etherpad
      // instance. (Important caveat: Client-side database caching, which ueberdb does by default,
      // could still cause the record to be prematurely deleted because this instance might get a
      // stale expiration time from cache.)
      const timeout = setTimeout(() => this._get(id), exp - Date.now());
      this._expirations.set(id, {exp, timeout});
    } else {
      this._expirations.delete(id);
    }
  }

  async _get(sid) {
    logger.debug(`GET ${sid}`);
    const s = await DB.get(`sessionstorage:${sid}`);
    const {cookie: {expires} = {}} = s || {};
    if (expires && new Date() >= new Date(expires)) return await this._destroy(sid);
    if (s) this._scheduleCleanup(s);
    return s;
  }

  async _write(sid, sess) {
    this._scheduleCleanup(sess);
    await DB.set(`sessionstorage:${sid}`, sess);
  }

  async _set(sid, sess) {
    logger.debug(`SET ${sid}`);
    await this._write(sid, sess);
  }

  async _destroy(sid) {
    logger.debug(`DESTROY ${sid}`);
    clearTimeout((this._expirations.get(sid) || {}).timeout);
    this._expirations.delete(sid);
    await DB.remove(`sessionstorage:${sid}`);
  }

  async _touch(sid, sess) {
    logger.debug(`TOUCH ${sid}`);
    if (!sess.cookie.expires || this._refresh == null) return;
    const {exp: dbVal} = this._expirations.get(sid) || {};
    if (dbVal != null && new Date(sess.cookie.expires).getTime() < dbVal + this._refresh) return;
    await this._write(sid, sess);
  }
}

// express-session doesn't support Promise-based methods. This is where the callbackified versions
// used by express-session are defined.
for (const m of ['get', 'set', 'destroy', 'touch']) {
  SessionStore.prototype[m] = util.callbackify(SessionStore.prototype[`_${m}`]);
}

module.exports = SessionStore;
