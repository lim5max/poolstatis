import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { StoreProvider } from './store';
import { App } from './App';
import { OptionalAuth0Provider } from './auth0';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OptionalAuth0Provider>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <StoreProvider>
          <TooltipProvider delayDuration={200}>
            <App />
          </TooltipProvider>
        </StoreProvider>
      </BrowserRouter>
    </OptionalAuth0Provider>
  </StrictMode>,
);
