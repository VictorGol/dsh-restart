window.__ModuleLoader__.load({
  id: 'dsh-restart',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState } = React;

    const NS = 'dsh-restart';
    const ROUTE = '/dsh-restart/restart';
    /** Gap and height of the pill, in px, next to the page title. */
    const GAP = 10;
    const HEIGHT = 26;
    const WIDTH = 84;

    const ZH = {
      label: '重启 DSH',
      restart: '重启',
      restarting: '重启中…',
      failed: '重启失败',
      hint: '重启 DeepSeek Harness，让插件改动生效（会中断正在运行的任务）',
    };
    const EN = {
      label: 'Restart DSH',
      restart: 'Restart',
      restarting: 'Restarting…',
      failed: 'Restart failed',
      hint: 'Restart DeepSeek Harness so plugin changes take effect (interrupts running tasks)',
    };

    const CSS = [
      '.dshrestart-btn{position:fixed;z-index:45;display:inline-flex;align-items:center;justify-content:center;gap:5px;box-sizing:border-box;height:' + HEIGHT + 'px;padding:0 9px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12.5px;font-weight:500;line-height:18px;cursor:pointer;-webkit-app-region:no-drag;box-shadow:0 1px 2px rgba(0,0,0,.06);transition:background .12s ease,color .12s ease,border-color .12s ease}',
      '@media (hover:hover){.dshrestart-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}',
      '.dshrestart-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}',
      '.dshrestart-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.dshrestart-btn:disabled{cursor:default}',
      '.dshrestart-btn[data-phase=busy],.dshrestart-btn[data-phase=done]{color:var(--dsw-alias-label-tertiary)}',
      '.dshrestart-btn[data-phase=failed]{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent)}',
      '.dshrestart-icon{display:block;flex:none;transform-origin:center}',
      '.dshrestart-btn[data-phase=busy] .dshrestart-icon,.dshrestart-btn[data-phase=done] .dshrestart-icon{animation:dshrestart-spin .9s linear infinite}',
      '@keyframes dshrestart-spin{to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion:reduce){.dshrestart-btn[data-phase=busy] .dshrestart-icon,.dshrestart-btn[data-phase=done] .dshrestart-icon{animation:none}}',
    ].join('\n');

    const icon = h('svg', {
      className: 'dshrestart-icon',
      viewBox: '0 0 12 12',
      width: 12,
      height: 12,
      'aria-hidden': true,
      focusable: 'false',
    }, h('path', {
      d: 'M6 1.7a4.3 4.3 0 1 1-3.1 1.3',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.4,
      'stroke-linecap': 'round',
    }), h('path', {
      d: 'M2.6 0.9v2.9h2.9',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.4,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }));

    /**
     * The Plugin Manager paints its own title part (the measuring clone is
     * tagged data-measuring), so the button follows the real title while it is
     * on screen and disappears with the page.
     */
    function findTitle() {
      const titles = document.querySelectorAll('[data-plugin-header-part="title"]');
      for (const title of titles) {
        if (title.closest('[data-measuring]') !== null) continue;
        const box = title.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) return { title, box };
      }
      return null;
    }

    function RestartButton({ t }) {
      const [position, setPosition] = useState(null);
      const [phase, setPhase] = useState('idle');
      const [detail, setDetail] = useState('');

      useEffect(() => {
        let frame = 0;
        const measure = () => {
          frame = 0;
          const found = findTitle();
          const bar = found === null ? null : found.title.closest('[data-plugin-bar]');
          const visible = found !== null && (bar === null || !bar.hasAttribute('data-compact'));
          if (!visible) {
            setPosition((previous) => (previous === null ? previous : null));
            return;
          }
          const left = Math.max(0, Math.min(found.box.right + GAP, window.innerWidth - WIDTH));
          const top = found.box.top + (found.box.height - HEIGHT) / 2;
          setPosition((previous) => (
            previous !== null
            && Math.abs(previous.left - left) < 0.5
            && Math.abs(previous.top - top) < 0.5
              ? previous
              : { left, top }
          ));
        };
        const schedule = () => {
          if (frame === 0) frame = window.requestAnimationFrame(measure);
        };
        const observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true });
        window.addEventListener('resize', schedule);
        window.addEventListener('scroll', schedule, true);
        schedule();
        return () => {
          observer.disconnect();
          window.removeEventListener('resize', schedule);
          window.removeEventListener('scroll', schedule, true);
          if (frame !== 0) window.cancelAnimationFrame(frame);
        };
      }, []);

      const restart = async () => {
        if (phase === 'busy' || phase === 'done') return;
        setPhase('busy');
        setDetail('');
        try {
          const response = await fetch(ROUTE, {
            method: 'POST',
            headers: { 'x-dsh-restart': '1' },
            cache: 'no-store',
          });
          let payload = null;
          try {
            payload = await response.json();
          } catch {
            payload = null;
          }
          if (!response.ok) {
            throw new Error(payload !== null && typeof payload.error === 'string' && payload.error !== ''
              ? payload.error
              : 'HTTP ' + response.status);
          }
          setPhase('done');
        } catch (error) {
          setPhase('failed');
          setDetail(error instanceof Error && error.message !== '' ? error.message : String(error));
          window.setTimeout(() => {
            setPhase('idle');
            setDetail('');
          }, 6000);
        }
      };

      if (position === null) return null;

      const label = phase === 'done' || phase === 'busy'
        ? t('restarting')
        : phase === 'failed'
          ? t('failed')
          : t('restart');

      return h(React.Fragment, null,
        h('style', { key: 'css' }, CSS),
        h('button', {
          key: 'button',
          type: 'button',
          className: 'dshrestart-btn',
          'data-phase': phase,
          style: { left: position.left + 'px', top: position.top + 'px' },
          title: phase === 'failed' && detail !== '' ? detail : t('hint'),
          'aria-label': t('hint'),
          disabled: phase === 'busy' || phase === 'done',
          onClick: restart,
        }, icon, h('span', { className: 'dshrestart-label' }, label)));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH));
        ctx.effect(() => ctx.locale.register(NS, 'en', EN));
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: NS,
          order: 20,
          locale: NS,
          label: () => t('label'),
        }, () => h(RestartButton, { t })));
      },
    };
  },
});
