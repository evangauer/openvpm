import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import { db } from "@openpims/db/client";
import { users } from "@openpims/db";
import { eq } from "drizzle-orm";
import { withSystem } from "@/lib/tenant-db";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      role: "admin" | "veterinarian" | "technician" | "front_desk" | "viewer";
      practiceId: string;
    };
  }
  interface User {
    id: string;
    email: string;
    name: string;
    role: "admin" | "veterinarian" | "technician" | "front_desk" | "viewer";
    practiceId: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: "admin" | "veterinarian" | "technician" | "front_desk" | "viewer";
    practiceId: string;
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        // Login looks up by email with no tenant context yet → system context.
        const [user] = await withSystem(db, (tx) =>
          tx
            .select()
            .from(users)
            .where(eq(users.email, credentials.email))
            .limit(1)
        );

        if (!user) return null;

        const isValid = await compare(credentials.password, user.passwordHash);
        if (!isValid) return null;

        // Email verification is a SOFT requirement on hosted: new users sign in
        // immediately after signup (so the trial + onboarding aren't blocked by
        // an email round-trip) and are nudged to confirm via an in-app banner.
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          practiceId: user.practiceId,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = user.role;
        token.practiceId = user.practiceId;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.id;
      session.user.role = token.role;
      session.user.practiceId = token.practiceId;
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
  },
  secret: process.env.NEXTAUTH_SECRET,
};
