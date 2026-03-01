'use client';
  
  import { useEffect, useState } from 'react';
  import { getPolls } from '../lib/voting-api';
  import { Poll } from '../types';
  import { PollCard } from '../components/features/PollCard';
  import { Button } from '../components/ui/Button';
  import Link from 'next/link';
  
  export default function HomePage() {
    const [polls, setPolls] = useState<Poll[]>([]);
    const [loading, setLoading] = useState(true);
    
    useEffect(() => {
      loadPolls();
    }, []);
    
    async function loadPolls() {
      const data = await getPolls();
      setPolls(data);
      setLoading(false);
    }
    
    return (
      <main className="container mx-auto p-4">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">CKB Voting</h1>
          <Link href="/create">
            <Button>Create Poll</Button>
          </Link>
        </div>
        
        {loading ? (
          <p>Loading polls...</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {polls.map(poll => (
              <PollCard key={poll.id} poll={poll} />
            ))}
          </div>
        )}
      </main>
    );
  }