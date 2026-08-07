# Core Hook Rules (Universal)

## The fundamental rules of React hooks apply everywhere

    Call hooks at the top level of your functional components, not inside conditionals, loops, or nested functions
    Only call hooks from React function components or custom hooks, never from regular JavaScript functions
    Use the ESLint plugin (eslint-plugin-react-hooks) to catch violations automatically

typescript

// ✅ Good
function MyComponent() {
  const [count, setCount] = useState(0);
  const data = useFetchData();

  return <div>{count}</div>;
}

// ❌ Bad - hooks inside conditional
function MyComponent() {
  if (condition) {
    const [count, setCount] = useState(0);
  }
  return <div></div>;
}

## Electron-Specific Hook Patterns

Managing IPC Communication with Custom Hooks

In Electron, you'll frequently communicate between the renderer process (React) and main process. Create custom hooks to abstract this logic:
typescript

// hooks/useIpcEvent.ts
import { useEffect, useState } from 'react';
import { ipcRenderer } from 'electron';

export function useIpcEvent<T>(
  channel: string,
  initialValue: T
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(initialValue);

  useEffect(() => {
    // Listen for events from main process
    const handleIpcEvent = (_event: any, data: T) => {
      setValue(data);
    };

    ipcRenderer.on(channel, handleIpcEvent);

    return () => {
      ipcRenderer.removeListener(channel, handleIpcEvent);
    };
  }, [channel]);

  const send = (newValue: T) => {
    ipcRenderer.send(channel, newValue);
  };

  return [value, send];
}

Usage:
typescript

function MyComponent() {
  const [appConfig, setAppConfig] = useIpcEvent('app:config', {});

  return (
    <div>
      <button onClick={() => setAppConfig({...})}>Update</button>
    </div>
  );
}

## Working with useEffect and Process Lifecycle

Be careful with cleanup in Electron apps. Window closing and process termination happen differently than browser navigation:
typescript

function MyComponent() {
  useEffect(() => {
    const handleWindowClose = () => {
      console.log('Window is closing');
    };

    window.addEventListener('beforeunload', handleWindowClose);

    // Always clean up IPC listeners and event handlers
    return () => {
      window.removeEventListener('beforeunload', handleWindowClose);
    };
  }, []);

  return <div>Component</div>;
}

## useRef for Native Elements and Modules

Use useRef when you need to interact with native Electron APIs or DOM elements directly:
typescript

import { useRef, useEffect } from 'react';
import { ipcRenderer } from 'electron';

function FileUploader() {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = async () => {
    const files = fileInputRef.current?.files;
    if (files) {
      const result = await ipcRenderer.invoke('file:upload', Array.from(files));
    }
  };

  return (
    <>
      <input ref={fileInputRef} type="file" hidden />
      <button onClick={handleUpload}>Upload</button>
    </>
  );
}

## Custom Hook: useElectronApp

Create a hook to access common app lifecycle events:
typescript

// hooks/useElectronApp.ts
import { useEffect } from 'react';
import { ipcRenderer } from 'electron';

interface AppEvents {
  onReady?: () => void;
  onWindowFocus?: () => void;
  onWindowBlur?: () => void;
  onBeforeClose?: () => void;
}

export function useElectronApp(events: AppEvents) {
  useEffect(() => {
    if (events.onWindowFocus) {
      ipcRenderer.on('window:focus', events.onWindowFocus);
    }
    if (events.onWindowBlur) {
      ipcRenderer.on('window:blur', events.onWindowBlur);
    }
    if (events.onBeforeClose) {
      window.addEventListener('beforeunload', events.onBeforeClose);
    }

    return () => {
      ipcRenderer.removeAllListeners('window:focus');
      ipcRenderer.removeAllListeners('window:blur');
      if (events.onBeforeClose) {
        window.removeEventListener('beforeunload', events.onBeforeClose);
      }
    };
  }, [events]);
}

## useCallback for Stable Function References

This is especially important when passing callbacks through IPC or storing them:
typescript

import { useCallback } from 'react';

function MyComponent() {
  const handleDataRefresh = useCallback(async () => {
    const data = await ipcRenderer.invoke('data:refresh');
    // process data
  }, []); // Dependencies array is crucial

  return <button onClick={handleDataRefresh}>Refresh</button>;
}

## TypeScript Best Practices with Hooks

Always type your state and custom hooks:
typescript

// ✅ Explicit typing
const [user, setUser] = useState<{ id: number; name: string } | null>(null);

// ✅ Custom hook with generics
function useFetch<T>(url: string): [T | null, boolean, Error | null] {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    // fetch logic
  }, [url]);

  return [data, loading, error];
}

## Common Pitfalls to Avoid

Issue | Problem | Solution
Dangling IPC listeners | Memory leaks when component unmounts | Always remove listeners in useEffect cleanup
Missing dependency arrays | Infinite loops or stale closures | Include all external variables in dependencies
Sync/async mismatches | useEffect can't be async; invoking IPC can be | Use async IIFE inside useEffect or wrap in separate function
Heavy computations in render | Performance issues | Use useMemo to memoize expensive calculations
Not handling Electron context | Code breaks in main process or preload | Only call Electron APIs from renderer process; type-check availability

## Performance Optimization

typescript

import { useMemo, useCallback } from 'react';

function DataDisplay({ items }: { items: any[] }) {
  // Memoize expensive computations
  const sortedItems = useMemo(() => {
    return items.sort((a, b) => a.name.localeCompare(b.name));
  }, [items]);

  // Memoize callback to prevent child re-renders
  const handleItemClick = useCallback((id: string) => {
    ipcRenderer.send('item:select', id);
  }, []);

  return (
    <div>
      {sortedItems.map(item => (
        <ItemRow key={item.id} item={item} onClick={handleItemClick} />
      ))}
    </div>
  );
}

The key difference in Electron projects is being extra vigilant about cleanup since process lifecycle is different from web apps. Otherwise, hooks work exactly as they do in standard React applications—follow the rules, use TypeScript for safety, and leverage custom hooks to abstract Electron-specific patterns.
