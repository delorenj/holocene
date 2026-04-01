import { useQuery } from '@tanstack/react-query';
import type { EchoboxHealth, EchoboxJob } from '../types/echobox';

const ECHOBOX_API = '/api/echobox';

export function useEchoboxHealth() {
  return useQuery<EchoboxHealth>({
    queryKey: ['echobox', 'health'],
    queryFn: async () => {
      const res = await fetch(`${ECHOBOX_API}/healthz`);
      if (!res.ok) throw new Error('Echobox ledger unreachable');
      return res.json();
    },
    staleTime: 10_000,
    refetchInterval: 15_000,
    retry: 1,
  });
}

export function useEchoboxJobs() {
  return useQuery<EchoboxJob[]>({
    queryKey: ['echobox', 'jobs'],
    queryFn: async () => {
      const res = await fetch(`${ECHOBOX_API}/jobs`);
      if (!res.ok) throw new Error('Failed to fetch jobs');
      return res.json();
    },
    staleTime: 10_000,
    refetchInterval: 15_000,
    retry: 1,
  });
}
