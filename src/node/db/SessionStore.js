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
    // Maps session ID to ms since epoch (not a Date object).
    this._expirations = new Map();
  }

  async _get(sid) {
    logger.debug(`GET ${sid}`);
    this._expirations.delete(sid);
    const s = await DB.get(`sessionstorage:${sid}`);
    let {cookie: {expires} = {}} = s || {};
    if (expires) {
      expires = new Date(expires);
      if (new Date() >= expires) return await this._destroy(sid);
      this._expirations.set(sid, expires.getTime());
    }
    return s;
  }

  async _write(sid, sess) {
    if (sess.cookie.expires) this._expirations.set(sid, new Date(sess.cookie.expires).getTime());
    else this._expirations.delete(sid);
    await DB.set(`sessionstorage:${sid}`, sess);
  }

  async _set(sid, sess) {
    logger.debug(`SET ${sid}`);
    await this._write(sid, sess);
  }

  async _destroy(sid) {
    logger.debug(`DESTROY ${sid}`);
    this._expirations.delete(sid);
    await DB.remove(`sessionstorage:${sid}`);
  }

  async _touch(sid, sess) {
    logger.debug(`TOUCH ${sid}`);
    if (!sess.cookie.expires || this._refresh == null) return;
    const dbVal = this._expirations.get(sid);
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
