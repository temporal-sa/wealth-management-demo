import React, { useState, useEffect, useCallback } from 'react';
import './App.css';
import { API_BASE_URL } from './config';
import ChaosPanel from './ChaosPanel';
import ChatPane from './ChatPane';

// How often to read the API's config again, to see which frameworks' workers have started or stopped
const CONFIG_REFRESH_MS = 10000;

// The API's GET /api/config: the AI frameworks it serves, each with its label and whether a worker
// runs its chats. Null if the API can't be reached.
async function fetchFrameworks() {
  try {
    const response = await fetch(`${API_BASE_URL}/config`);
    if (response.ok) {
      const config = await response.json();
      return Array.isArray(config.frameworks) ? config.frameworks : null;
    }
  } catch (error) {
    console.log(`Couldn't read the API's config: ${error}`);
  }
  return null;
}

const SHOW_CHAOS_KEY = 'showChaosPanel';

function loadShowChaos() {
  try {
    return localStorage.getItem(SHOW_CHAOS_KEY) === 'true';
  } catch (e) {
    return false;
  }
}

// The chat with a tab for each AI framework the API serves. Each tab keeps its own live chat, so the
// same questions can be put to several frameworks side by side. With one framework there are no tabs.
function App() {
  const [frameworks, setFrameworks] = useState(null);
  const [selected, setSelected] = useState(null);
  // Per framework: {active: a chat is running, unseen: a reply arrived while its tab was hidden}
  const [tabState, setTabState] = useState({});
  const [showChaos, setShowChaos] = useState(loadShowChaos);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const latest = await fetchFrameworks();
      if (cancelled || latest === null) return;
      setFrameworks(latest);
      setSelected((current) => (
        latest.some((f) => f.framework === current) ? current : (latest[0] && latest[0].framework)
      ));
    };
    refresh();
    const intervalId = setInterval(refresh, CONFIG_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  const updateTab = useCallback((name, patch) => {
    setTabState((prev) => ({ ...prev, [name]: { ...prev[name], ...patch } }));
  }, []);

  const selectTab = (name) => {
    setSelected(name);
    updateTab(name, { unseen: false });
  };

  const handleToggleChaos = () => {
    const next = !showChaos;
    setShowChaos(next);
    try {
      localStorage.setItem(SHOW_CHAOS_KEY, String(next));
    } catch (e) {
      // Not remembered across reloads; the panel still toggles.
    }
  };

  // Without the API's config, one chat that starts without naming a framework
  const panes = frameworks && frameworks.length > 0 ? frameworks : [null];
  const current = panes.find((f) => f && f.framework === selected) || null;

  return (
    <div className="layout">
      <div className="App">
        <div className="header">
          Wealth Management Chatbot
          {current && <div className="framework">AI framework: {current.label}</div>}
          <button className="chaos-toggle" onClick={handleToggleChaos}>
            {showChaos ? 'Hide chaos' : 'Chaos'}
          </button>
        </div>
        {panes.length > 1 && (
          <div className="framework-tabs" role="tablist">
            {panes.map((f) => {
              const state = tabState[f.framework] || {};
              const classes = ['framework-tab'];
              if (f.framework === selected) classes.push('selected');
              if (!f.available) classes.push('unavailable');
              return (
                <button
                  key={f.framework}
                  role="tab"
                  aria-selected={f.framework === selected}
                  className={classes.join(' ')}
                  title={f.available
                    ? `${f.label} (task queue ${f.task_queue})`
                    : `${f.label}: no worker is polling task queue ${f.task_queue}`}
                  onClick={() => selectTab(f.framework)}
                >
                  {state.active && <span className="tab-live" aria-label="chat running" />}
                  {f.tab_label || f.label}
                  {state.unseen && f.framework !== selected && <span className="tab-unseen" aria-label="new replies" />}
                </button>
              );
            })}
          </div>
        )}
        {panes.map((f) => (
          <ChatPane
            key={f ? f.framework : 'default'}
            framework={f}
            visible={f === null || f.framework === selected}
            onChange={(patch) => f && updateTab(f.framework, patch)}
          />
        ))}
      </div>
      {showChaos && <ChaosPanel />}
    </div>
  );
}

export default App;
