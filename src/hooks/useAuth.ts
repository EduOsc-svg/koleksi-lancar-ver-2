import { useState, useEffect } from "react";
import { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Restore session DULU dari storage sebelum subscribe
    // Ini mencegah race condition dimana onAuthStateChange fire dengan session=null
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);

      // BARU subscribe SETELAH restore selesai
      // Ini memastikan isLoading=false sebelum onAuthStateChange bisa fire dengan session=null
      const { data: { subscription } } = supabase.auth.onAuthStateChange(
        (_event, session) => {
          console.log('Auth state changed:', { event: _event, hasSession: !!session });
          setSession(session);
          setUser(session?.user ?? null);
        }
      );

      setIsLoading(false);

      return () => subscription.unsubscribe();
    });
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return {
    user,
    session,
    isLoading,
    signOut,
    isAuthenticated: !!session,
  };
}
