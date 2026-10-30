import { api, Dashboard } from '../../services/api';
import { coachHistory } from '../../services/coach-history';
import { config } from '../../config';
Page({
  data: { busy: false, error: '', coachId: '', month: '', detail: null as ReturnType<typeof coachHistory> },
  onLoad(options: Record<string, string | undefined>) {
    this.setData({ coachId: options.id || '', month: options.month || '' });
    this.refresh();
  },
  onPullDownRefresh() { this.refresh().finally(() => wx.stopPullDownRefresh()); },
  async refresh() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '', detail: null });
    try {
      if (!this.data.coachId || !/^\d{4}-(0[1-9]|1[0-2])$/.test(this.data.month)) throw new Error('缺少教练或月份信息，请返回重新选择。');
      const data = await api<Dashboard>('admin', { action: 'dashboard' });
      if (config.mode !== 'demo' && (data.profile?.status !== 'active' || !data.profile.roles.includes('admin'))) throw new Error('仅管理员可查看授课明细。');
      if (!data.adminFinance) throw new Error('暂未获取到授课数据，请重试。');
      const detail = coachHistory(data.adminFinance, this.data.coachId, this.data.month);
      if (!detail) throw new Error('未找到该教练，请返回刷新列表。');
      this.setData({ detail });
    } catch (e) { this.setData({ error: e instanceof Error ? e.message : '加载失败，请重试。' }); }
    finally { this.setData({ busy: false }); }
  },
});
