window.__ModuleLoader__.load({
  id: 'dsh-restart-harness',
  factory: (require) => {
    const React = require('react');
    const exports = {};
    exports.inject = ['slots', 'timer'];
    exports.apply = function apply(ctx) {
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'harness-restart',
        order: 100,
        inject: () => ({})
      }, function RestartRow() {
        const [confirming, setConfirming] = React.useState(false);
        const [pending, setPending] = React.useState(false);
        const [error, setError] = React.useState('');
        const requestRestart = () => {
          setPending(true);
          setError('');
          const readStatus = () => fetch('/dsh-restart/status', { cache: 'no-store' }).then((response) => response.json());
          readStatus().then((before) => fetch('/dsh-restart/restart', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
          }).then((response) => response.json().then((body) => ({ status: response.status, body, before }))))
            .then((result) => {
              if (result.status !== 202 || !result.body || result.body.ok !== true) {
                throw new Error(result.body && result.body.error ? String(result.body.error) : '重启请求失败');
              }
              const oldBoot = typeof result.before.boot === 'string' ? result.before.boot : '';
              const deadline = Date.now() + 60000;
              const poll = () => {
                readStatus().then((next) => {
                  if (typeof next.boot === 'string' && next.boot !== oldBoot) {
                    location.reload();
                    return;
                  }
                  if (Date.now() >= deadline) throw new Error('等待 DeepSeek Harness 启动超时');
                  ctx.timeout(poll, 1500);
                }).catch((pollError) => {
                  if (Date.now() >= deadline) {
                    setPending(false);
                    setConfirming(false);
                    setError(pollError instanceof Error ? pollError.message : String(pollError));
                    return;
                  }
                  ctx.timeout(poll, 1500);
                });
              };
              poll();
            })
            .catch((requestError) => {
              setPending(false);
              setConfirming(false);
              setError(requestError instanceof Error ? requestError.message : String(requestError));
            });
        };
        const description = error || (confirming ? '重启会中断当前正在进行的任务。确定继续吗？' : '安全重启宿主进程，并等待新进程接管。');
        return React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '14px 0', borderBottom: '1px solid var(--dsw-alias-border-divider)' } },
          React.createElement('div', { style: { minWidth: 0 } },
            React.createElement('div', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: 14, lineHeight: '22px' } }, '重启 DeepSeek Harness'),
            React.createElement('div', { style: { marginTop: 2, color: error ? 'var(--dsw-alias-label-danger)' : 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px' } }, description)
          ),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flex: 'none' } },
            confirming && React.createElement('button', { type: 'button', onClick: () => { setConfirming(false); setError(''); }, disabled: pending }, '取消'),
            React.createElement('button', { type: 'button', onClick: confirming ? requestRestart : () => { setConfirming(true); setError(''); }, disabled: pending }, pending ? '正在重启…' : confirming ? '确定重启' : '重启')
          )
        );
      }));
    };
    return exports;
  }
});
