/**
 * AgentsChat identity chip — per-conversation identity for DSH.
 *
 * Why a chip and not a tool: `switch_profile` is process-global, so a model call
 * could silently re-point every conversation. This puts the decision where the
 * consequence is: the conversation itself. Picking a profile here writes
 * `session-binds.json` through the inbound bridge, and the MCP server's per-call
 * routing picks it up on the next tool call (no restart, no global switch).
 *
 * Reads only the loopback bridge (`127.0.0.1:8799`); tokens never leave the host.
 */
window.__ModuleLoader__.load({
  id: 'agentschat-identity',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const API = 'http://127.0.0.1:8799/identity';
    const CHAT = 'https://agents-chat.com/chat/';

    // Liveness probe: a blank UI otherwise cannot be told apart from a module
    // that never executed. Each stage reports once; failures carry the message.
    const ALIVE = 'http://127.0.0.1:8799/identity/alive';
    let mountedOnce = false;
    function report(payload) {
      try {
        void fetch(ALIVE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(function () {});
      } catch (e) {}
    }

    const dot = (on) => ({
      width: '6px',
      height: '6px',
      borderRadius: '999px',
      flex: 'none',
      background: on ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-tertiary)',
    });
    const chipStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      height: '24px',
      padding: '0 9px',
      borderRadius: '999px',
      border: '0.5px solid var(--dsw-alias-border-l1)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
      fontSize: '12px',
      cursor: 'pointer',
    };
    const panelStyle = {
      position: 'absolute',
      bottom: '30px',
      left: '0',
      zIndex: 20,
      minWidth: '248px',
      padding: '6px',
      borderRadius: 'var(--dsw-radius-md)',
      border: '0.5px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-specific-menu)',
      boxShadow: 'var(--dsw-elevation-panel)',
    };
    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      width: '100%',
      minHeight: '28px',
      padding: '4px 8px',
      borderRadius: 'var(--dsw-radius-sm)',
      border: 0,
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '12px',
      textAlign: 'left',
      cursor: 'pointer',
    };

    function Chip({ sessionId }) {
      const [data, setData] = React.useState(null);
      const [open, setOpen] = React.useState(false);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);

      const refresh = React.useCallback(async () => {
        if (!sessionId) return;
        try {
          const res = await fetch(API, { cache: 'no-store' });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          setData(await res.json());
          setError('');
        } catch {
          setError('bridge 未响应');
        }
      }, [sessionId]);

      React.useEffect(() => {
        void refresh();
        if (!mountedOnce) {
          mountedOnce = true;
          report({ phase: 'mounted' });
        }
      }, [refresh]);

      const boundName = data && sessionId ? data.binds[sessionId] : undefined;
      const profile = data && boundName ? data.profiles.find((p) => p.name === boundName) : undefined;

      async function call(path, payload) {
        setBusy(true);
        try {
          const res = await fetch(API + path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok || body.ok !== true) throw new Error(body.error || 'HTTP ' + res.status);
          setError('');
          setOpen(false);
          setData((prev) => ({
            ...(prev || { profiles: [] }),
            ...(Array.isArray(body.profiles) ? { profiles: body.profiles } : {}),
            binds: body.binds,
          }));
        } catch (e) {
          setError(String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      }

      const label = profile
        ? profile.displayName || profile.agentId
        : error
          ? error
          : sessionId
            ? '未绑定身份'
            : '无会话';

      return h(
        'div',
        { style: { position: 'relative', display: 'inline-flex' } },
        h(
          'button',
          {
            type: 'button',
            style: chipStyle,
            title: profile
              ? 'AgentsChat 身份：' + profile.agentId + '（点击更换）'
              : '为这个会话绑定 AgentsChat 身份',
            onClick: () => {
              setOpen((value) => !value);
              void refresh();
            },
          },
          h('span', { style: dot(Boolean(profile)) }),
          h(
            'span',
            { style: { maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            label,
          ),
        ),
        open
          ? h(
              'div',
              { style: panelStyle },
              h(
                'div',
                { style: { padding: '4px 8px 6px', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' } },
                '这个会话用哪个 AgentsChat 身份',
              ),
              (data && data.profiles ? data.profiles : []).slice(0, 8).map((entry) =>
                h(
                  'button',
                  {
                    key: entry.name,
                    type: 'button',
                    style: rowStyle,
                    disabled: busy,
                    title: entry.agentId,
                    onClick: () => void call('/bind', { sessionId, profileName: entry.name }),
                  },
                  h('span', { style: dot(entry.name === boundName) }),
                  h(
                    'span',
                    { style: { flex: '1', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    entry.displayName || entry.name,
                  ),
                  h('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' } }, entry.agentId.slice(0, 8)),
                ),
              ),
              sessionId
                ? h(
                    'button',
                    {
                      type: 'button',
                      style: {
                        ...rowStyle,
                        marginTop: '2px',
                        color: 'var(--dsw-alias-state-business-primary)',
                      },
                      disabled: busy,
                      onClick: () => void call('/create', { sessionId }),
                    },
                    h('span', { style: { fontSize: '13px', lineHeight: 1 } }, '+'),
                    h('span', null, busy ? '正在创建身份…' : '新建并绑定身份'),
                  )
                : null,
              profile
                ? h(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        marginTop: '4px',
                        padding: '6px 8px 2px',
                        borderTop: '0.5px solid var(--dsw-alias-border-l1)',
                      },
                    },
                    h(
                      'a',
                      {
                        style: { color: 'var(--dsw-alias-state-business-primary)', fontSize: '12px', textDecoration: 'none' },
                        href: CHAT + encodeURIComponent(profile.agentId),
                        target: '_blank',
                        rel: 'noreferrer',
                      },
                      '打开私聊',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: { ...rowStyle, width: 'auto', minHeight: 0, padding: '2px 0', color: 'var(--dsw-alias-label-tertiary)' },
                        disabled: busy,
                        onClick: () => void call('/unbind', { sessionId }),
                      },
                      '解除绑定',
                    ),
                  )
                : null,
              error && !profile
                ? h('div', { style: { padding: '4px 8px', fontSize: '11px', color: 'var(--dsw-alias-state-error-primary)' } }, error)
                : null,
            )
          : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        if (window.__AGENTSCHAT_IDENTITY_CHIP_MOUNTED__) {
          report({ phase: 'skipped-duplicate', module: 'agentschat-identity' });
          return;
        }
        window.__AGENTSCHAT_IDENTITY_CHIP_MOUNTED__ = true;
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => () => {
            window.__AGENTSCHAT_IDENTITY_CHIP_MOUNTED__ = false;
          });
        }
        report({ phase: 'factory', slots: Boolean(ctx && ctx.slots) });
        try {
          ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register(
              {
                name: 'conversation.composer.dock',
                id: 'agentschat-identity',
                order: 30,
                inject: (sessionId) => ({ sessionId }),
              },
              Chip,
            ),
          );
          report({ phase: 'registered' });
        } catch (error) {
          window.__AGENTSCHAT_IDENTITY_CHIP_MOUNTED__ = false;
          report({ phase: 'register-failed', error: String((error && error.message) || error) });
          throw error;
        }
      },
    };
  },
});
