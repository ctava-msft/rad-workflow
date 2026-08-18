import {
  InteractionRequiredAuthError,
  PublicClientApplication,
} from "@azure/msal-browser";
import { apiRequest } from "./auth/authConfig";

export type CaseStatus =
  | "candidate"
  | "selected"
  | "in-review"
  | "consensus"
  | "closed";
export type CasePriority = "routine" | "urgent" | "stat";
export type ReviewRecommendation = "include" | "exclude" | "discuss";

export interface RadiologyCase {
  id: string;
  accession_number: string;
  patient_reference: string;
  modality: string;
  body_part: string;
  clinical_question: string;
  priority: CasePriority;
  selection_reason: string;
  status: CaseStatus;
  assigned_to: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
  review_count: number;
}

export interface CaseReview {
  id: string;
  case_id: string;
  recommendation: ReviewRecommendation;
  comment: string;
  author: string;
  created_at: string;
}

export type CreateCaseInput = Pick<
  RadiologyCase,
  | "accession_number"
  | "patient_reference"
  | "modality"
  | "body_part"
  | "clinical_question"
  | "priority"
  | "selection_reason"
>;

declare global {
  interface Window {
    msalInstance: PublicClientApplication;
  }
}

async function getAccessToken(): Promise<string> {
  const instance = window.msalInstance;
  const account = instance.getActiveAccount() ?? instance.getAllAccounts()[0];
  if (!account) {
    throw new Error("No authenticated account is available.");
  }

  try {
    const response = await instance.acquireTokenSilent({
      ...apiRequest,
      account,
    });
    return response.accessToken;
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) {
      throw new Error("Your session needs attention. Sign out and sign in again.");
    }
    throw error;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
  const apiBaseUrl = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
  const response = await fetch(`${apiBaseUrl}/api${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { detail?: string }
      | null;
    throw new Error(payload?.detail ?? `Request failed (${response.status}).`);
  }

  return (await response.json()) as T;
}

export const radiologyApi = {
  listCases: () => request<RadiologyCase[]>("/cases"),
  createCase: (payload: CreateCaseInput) =>
    request<RadiologyCase>("/cases", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateCase: (caseId: string, changes: Partial<RadiologyCase>) =>
    request<RadiologyCase>(`/cases/${caseId}`, {
      method: "PATCH",
      body: JSON.stringify(changes),
    }),
  listReviews: (caseId: string) =>
    request<CaseReview[]>(`/cases/${caseId}/reviews`),
  createReview: (
    caseId: string,
    recommendation: ReviewRecommendation,
    comment: string,
  ) =>
    request<CaseReview>(`/cases/${caseId}/reviews`, {
      method: "POST",
      body: JSON.stringify({ recommendation, comment }),
    }),
};