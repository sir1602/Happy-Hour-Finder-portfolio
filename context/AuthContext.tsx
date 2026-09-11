import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { registerForPushNotificationsAsync } from '../services/notificationService';
import { authService } from '../services/authService';
import { Logger } from '../services/logger';
import { Analytics } from '../services/analytics';

type AuthContextType = {
  session: Session | null;
  user: User | null;
  isLoading: boolean;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  // Q5 fix: throw so we get a clear error when a component is accidentally
  // rendered outside AuthProvider, matching the pattern used by useDeals.
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    const syncPushToken = (userId?: string) => {
      if (!userId) return;
      void registerForPushNotificationsAsync(userId).catch((error: unknown) => {
        Logger.warn('[Auth] Failed to register push notifications', error);
      });
    };

    // QOL-9: Set/clear user context for crash reporting and analytics
    const syncUserContext = (userId?: string, email?: string) => {
      if (userId) {
        Logger.setUser(userId, email);
        Analytics.identify(userId, email ? { email } : undefined);
      } else {
        Logger.clearUser();
        Analytics.reset();
      }
    };

    // Check initial session
    authService.getSession()
      .then((session) => {
        if (!isMounted) return;
        setSession(session);
        setUser(session?.user ?? null);
        syncPushToken(session?.user?.id);
        syncUserContext(session?.user?.id, session?.user?.email ?? undefined);
      })
      .catch((err) => {
        Logger.warn('[Auth] Failed to get session on startup', err);
      })
      .finally(() => {
        if (isMounted) {
          setIsLoading(false);
        }
      });

    // Listen for auth changes
    const subscription = authService.onAuthStateChange((_event, session) => {
      if (!isMounted) return;
      setSession(session);
      setUser(session?.user ?? null);
      syncPushToken(session?.user?.id);
      syncUserContext(session?.user?.id, session?.user?.email ?? undefined);
      setIsLoading(false);
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const value = useMemo(
    () => ({ session, user, isLoading }),
    [session, user, isLoading]
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};
