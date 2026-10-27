// Isolated source checks. No SDK installation, cloud access, or production data.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../.research/WeCourse');
class Base { AppError(message) { throw new Error(message); } }
function load(rel, deps = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, rel), 'utf8'), {
    module, require(id) {
      if (id in deps) return deps[id];
      if (id.includes('base_project_')) return Base;
      if (id.includes('log_util')) return class { error() {} };
      return {};
    }
  }, { filename: rel });
  return module.exports;
}
(async () => {
  const Admin = load('cloudfunctions/mcloud/project/lesson/service/admin/admin_meet_service.js');
  for (const name of ['changeCourse', 'joinDayTime', 'insertDayTime', 'editDayTime', 'delDayTime', 'insertMeet', 'editMeet', 'delJoin']) {
    await assert.rejects(() => new Admin()[name](), /该功能暂不开放/);
  }
  console.log('CONFIRMED: eight core mutation methods unconditionally reject.');
  assert.equal(typeof Admin.prototype.getHasDayByMonth, 'undefined');
  assert.equal(typeof Admin.prototype.cancelJoinByTimeMark, 'undefined');
  console.log('CONFIRMED: two controller-referenced methods are absent from AdminMeetService (source inheritance separately inspected).');
  const marker = { _id: 'fake-coach', MEET_PASSWORD: 'FAKE_HASH', MEET_TOKEN: 'FAKE_TOKEN' };
  let projection;
  const Meet = load('cloudfunctions/mcloud/project/lesson/service/meet_service.js', {
    '../model/meet_model.js': {
      STATUS: { COMM: 1, OVER: 9 },
      async getOne(where, fields) { projection = fields; return marker; }
    }
  });
  const returned = await new Meet().viewMeet('fake-coach');
  assert.equal(projection, '*');
  assert.equal(returned.MEET_TOKEN, 'FAKE_TOKEN');
  assert.equal(returned.MEET_PASSWORD, 'FAKE_HASH');
  console.log('CONFIRMED: detail service requests all fields and returns synthetic credential fields without filtering.');
  let inserted;
  const Passport = load('cloudfunctions/mcloud/project/lesson/service/passport_service.js', {
    '../model/user_model.js': { async count() { return 0; }, async insert(data) { inserted = data; } },
    '../../../framework/utils/data_util.js': { dbForms2Obj() { return {}; } }
  });
  const passport = new Passport();
  passport.login = async () => ({});
  await passport.register('fake-user', { mobile: 'synthetic', name: 'synthetic', forms: [], status: 1 });
  assert.equal(inserted.USER_STATUS, 1);
  console.log('CONFIRMED: registration persists client-supplied approval status.');
  console.log('LIMIT: isolated source behavior only; not WeChat/cloud end-to-end testing.');
})().catch(error => { console.error(error); process.exitCode = 1; });
