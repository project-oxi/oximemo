import { GDocumentEditor } from '@garden/editor';
import '@garden/editor/styles.css';
import { createMarkdownDocument, patchMarkdownEnvelope } from '@garden/markdown';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, GAppShell, GNavigation, GNavigationItem, GPage, GSettings, GSettingsGroup, GSettingsRow, Switch } from '@garden/ui';
import '@garden/ui/styles.css';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { open_settings } from '@garden/native';
import { getCurrentWindow } from '@tauri-apps/api/window';
import en from '../locales/en.json';
import ko from '../locales/ko.json';
import './style.css';

const t = navigator.language.startsWith('ko') ? { ...en, ...ko } : en;
const native = Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__);
const nativeMac = native && /Mac/.test(navigator.platform);
const sampleId = '01998ce5-1200-7000-8000-000000000010';
const sampleSource = patchMarkdownEnvelope(createMarkdownDocument({
  id: sampleId,
  title: t.sampleTitle,
  body: t.sampleBody,
}), { tags: [t.sampleTag], favorite: false });

function App() {
  const [settings, setSettings] = useState(native
    ? getCurrentWindow().label === 'settings'
    : new URLSearchParams(location.search).get('view') === 'settings');
  const [section, setSection] = useState('general');
  const [source, setSource] = useState(sampleSource);
  const [dark, setDark] = useState(localStorage.getItem('garden.theme') === 'dark');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!native) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<boolean>('garden:theme', event => setDark(event.payload)).then(unlisten => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  const changeTheme = (next: boolean) => {
    setDark(next);
    localStorage.setItem('garden.theme', next ? 'dark' : 'light');
    if (native) void emit('garden:theme', next);
  };

  const openSettings = () => {
    setError('');
    if (native) void open_settings(invoke).catch(() => setError(t.settingsError));
    else setSettings(true);
  };

  const nativeControls = native && !nativeMac ? <div className="desktop-native-controls">
    <Button className="desktop-native-controls__button" variant="ghost" size="icon" type="button" onClick={() => { void getCurrentWindow().close(); }} aria-label={t.close} title={t.close}>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8"><path d="m6 6 12 12M18 6 6 18" /></svg>
    </Button>
    <Button className="desktop-native-controls__button" variant="ghost" size="icon" type="button" onClick={() => { void getCurrentWindow().minimize(); }} aria-label={t.minimize} title={t.minimize}>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8"><path d="M5 12h14" /></svg>
    </Button>
    <Button className="desktop-native-controls__button" variant="ghost" size="icon" type="button" onClick={() => { void getCurrentWindow().toggleMaximize(); }} aria-label={t.maximize} title={t.maximize}>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
    </Button>
  </div> : null;

  return <div className={dark ? 'desktop-root dark' : 'desktop-root'}>
    <GAppShell
      appName={t.app}
      titleBar={{ left: nativeControls, macOSInset: nativeMac ? 80 : 0 }}
      contentPadding={settings ? 'none' : 'default'}
      sidebar={settings ? undefined : <GNavigation label={t.navigationLabel}>
        <GNavigationItem current onClick={() => setSettings(false)}>{t.documents}</GNavigationItem>
        <GNavigationItem onClick={openSettings}>{t.settings}</GNavigationItem>
      </GNavigation>}
      commandItems={[
        { id: 'settings', label: t.settings, onSelect: openSettings },
        ...(!native ? [{ id: 'documents', label: t.documents, onSelect: () => setSettings(false) }] : []),
      ]}
      strings={{
        mainLabel: t.workspace,
        sidebarLabel: t.documents,
        sidebarToggleLabel: t.toggleSidebar,
        rightPanelLabel: t.workspace,
        rightPanelToggleLabel: t.toggleRightPanel,
        bottomPanelLabel: t.workspace,
        composerLabel: t.editor,
        commandPalette: {
          ariaLabel: t.commands,
          searchPlaceholder: t.search,
          emptyTitle: t.empty,
          emptyHint: t.emptyHint,
          closeLabel: t.close,
        },
      }}
    >
      {error && <p className="desktop-error" role="alert">{error}</p>}
      {settings
        ? <GSettings
          strings={{ navigationLabel: t.settings, contentLabel: t.general }}
          title={t.settings}
          sections={[{ id: 'general', label: t.general }, { id: 'appearance', label: t.appearance }]}
          activeSection={section}
          onSectionChange={setSection}
        >
          <GSettingsGroup title={section === 'general' ? t.general : t.appearance}>
            <GSettingsRow label={t.theme} htmlFor="desktop-theme">
              <Switch id="desktop-theme" checked={dark} onCheckedChange={changeTheme} />
            </GSettingsRow>
          </GSettingsGroup>
        </GSettings>
        : <GPage width="reading">
          <GDocumentEditor
            value={source}
            onChange={setSource}
            documentId={sampleId}
            label={t.editor}
            strings={t.documentStrings}
          />
        </GPage>}
    </GAppShell>
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
