'use client'

import { createClient } from '@supabase/supabase-js'
import { useState } from 'react'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export default function Home() {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState('')

  const signIn = async () => {
    const { error } = await supabase.auth.signInWithOtp({ email })

    if (error) {
      setStatus('Error sending email')
    } else {
      setStatus('Check your email for the login link')
    }
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-[#08317b] text-white gap-6">

      {/* LOGO */}
      <img
        src="/logo.svg"
        alt="GC Route Logo"
        className="w-40 mb-2"
      />

      {/* TITLE */}
      <h1 className="text-4xl font-bold">
        GC Route Platform
      </h1>

      {/* EMAIL */}
      <input
        type="email"
        placeholder="Enter your email"
        className="border border-white bg-transparent text-white placeholder-white p-3 rounded w-72"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      {/* BUTTON */}
      <button
        onClick={signIn}
        className="bg-[#F5C400] text-[#2D3A5F] px-6 py-3 rounded font-bold text-lg"
      >
        Login / Register
      </button>

      {/* STATUS */}
      {status && <p>{status}</p>}

    </main>
  )
}


