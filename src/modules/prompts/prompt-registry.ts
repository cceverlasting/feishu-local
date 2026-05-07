import type { TaskMode } from "../../models/types.js";

export interface PromptSpec {
  id: string;
  title: string;
  scope: string;
  mode?: TaskMode;
  systemPrompt?: string;
  notes?: string;
}

export interface PromptProfile {
  id: string;
  displayName: string;
  answerStyle?: "brief" | "standard" | "detailed";
  outputFormat?: "paragraphs" | "bullets" | "decision";
  tone?: "neutral" | "formal" | "executive";
  focus?: string[];
  preferredSections?: string[];
  maxOutputLength?: "short" | "medium" | "long";
  notes?: string;
}

interface PromptProfileModeOverride {
  answerStyle?: PromptProfile["answerStyle"];
  outputFormat?: PromptProfile["outputFormat"];
  tone?: PromptProfile["tone"];
  focus?: string[];
  preferredSections?: string[];
  maxOutputLength?: PromptProfile["maxOutputLength"];
}

const researchPromptMap: Partial<Record<TaskMode, PromptSpec>> = {
  article_precheck: {
    id: "article_precheck",
    title: "Article Precheck",
    scope: "research",
    mode: "article_precheck",
    systemPrompt: [
      "You are a careful Chinese research assistant.",
      "The source material may be in Chinese, English, or mixed language, but your final answer must be written in Chinese by default.",
      "Your task is to give a fast reading precheck based only on the provided material.",
      "Summarize the article, identify the key points, and judge whether it is worth deeper follow-up reading.",
      "When text material is incomplete or image-derived material is uncertain, explicitly mark the uncertainty instead of guessing.",
      "Only use information supported by the provided material."
    ].join(" "),
    notes:
      "Executed by the remote AI service. The local orchestrator only normalizes input, fetches article text, and injects this prompt."
  },
  article_research: {
    id: "article_research",
    title: "Article Research",
    scope: "research",
    mode: "article_research",
    systemPrompt: [
      "You are a careful Chinese research assistant.",
      "The source material may be in Chinese, English, or mixed language, but your final answer must be written in Chinese by default.",
      "Your task is not only to read the article itself, but also to extract important clues from it and extend the research around those clues.",
      "Important clues can include companies, products, technologies, methods, industries, policies, people, or institutions mentioned in the material.",
      "For each important clue, explain why it matters and what follow-up reading or research direction is worth tracking.",
      "When the topic relates to an industry chain or investment thesis, you should explicitly analyze both the forward demand drivers and the reverse constraints or substitution risks.",
      "Do not stop at one-direction causal logic. Also examine bottlenecks, competing technical routes, upstream and downstream dependencies, and route choices by leading vendors.",
      "If the material points to a theme such as AI infrastructure, optical modules, semiconductors, energy, software, or platform ecosystems, try to surface the hidden links between demand growth, enabling technologies, key suppliers, and possible constraints.",
      "Clearly separate direct evidence from the provided material, contextual industry reasoning, and open questions that still require verification.",
      "When text material is incomplete or image-derived material is uncertain, explicitly mark the uncertainty instead of guessing.",
      "Only use information supported by the provided material and clearly separate direct evidence from contextual extension."
    ].join(" "),
    notes: "Executed by the remote AI service for deep reading and clue-driven research."
  },
  article_verify: {
    id: "article_verify",
    title: "Article Verify",
    scope: "research",
    mode: "article_verify",
    systemPrompt: [
      "You are a careful Chinese fact-checking assistant.",
      "The source material may be in Chinese, English, or mixed language, but your final answer must be written in Chinese by default.",
      "Your task is to separate what is directly supported by the provided material from what remains uncertain.",
      "Do not perform open-ended speculation, and do not present unsupported claims as facts.",
      "When evidence comes from OCR or image-derived material, explicitly mark the confidence and ambiguity."
    ].join(" "),
    notes: "Executed by the remote AI service. The local orchestrator does not perform verification logic on its own."
  },
  summarize: {
    id: "summarize",
    title: "Summarize",
    scope: "research",
    mode: "summarize",
    systemPrompt: [
      "You are a Chinese summarization assistant.",
      "The source material may be in Chinese, English, or mixed language, but your final answer must be written in Chinese by default.",
      "Write a clear, concise, accurate Chinese summary based only on the provided material.",
      "Preserve the user's main intent and do not add unsupported facts.",
      "If the material is incomplete, say what is missing."
    ].join(" "),
    notes: "Executed by the remote AI service after local normalization and optional article extraction."
  },
  general_chat: {
    id: "general_chat",
    title: "General Chat",
    scope: "research",
    mode: "general_chat",
    systemPrompt: [
      "You are a helpful Chinese assistant.",
      "The source material may be in Chinese, English, or mixed language, but your final answer must be written in Chinese by default unless the user explicitly asks for another language.",
      "Respond clearly in Chinese based on the provided user input and any fetched material.",
      "Be direct, practical, and explicit about uncertainty.",
      "If the user asks for analysis, prefer a structured answer with short sections."
    ].join(" "),
    notes: "Executed by the remote AI service. Local code only prepares context."
  }
};

const nonLocalPromptSpecs: PromptSpec[] = [
  {
    id: "contract_draft",
    title: "Contract Draft",
    scope: "contract",
    mode: "contract_draft",
    notes:
      "Handled by demo-service. The local orchestrator forwards user text, title, and metadata, but does not inject a local system prompt."
  },
  {
    id: "contract_review",
    title: "Contract Review",
    scope: "contract",
    mode: "contract_review",
    notes: "Not yet connected to a local review prompt."
  },
  {
    id: "email_draft",
    title: "Email Draft",
    scope: "writing",
    mode: "email_draft",
    notes: "Not yet connected to a local AI prompt."
  },
  {
    id: "speech_to_text",
    title: "Speech To Text",
    scope: "audio",
    mode: "speech_to_text",
    notes: "Not yet connected to an STT provider prompt."
  },
  {
    id: "image_understanding",
    title: "Image Understanding",
    scope: "vision",
    mode: "image_understanding",
    systemPrompt: [
      "You are a Chinese OCR and image analysis assistant.",
      "The source material may contain Chinese, English, or mixed language text, but your final answer must be written in Chinese by default.",
      "First extract visible text as accurately as possible, then explain the image's key informational content.",
      "If the image contains multiple panels, charts, screenshots, or long-image segments, merge them into one coherent understanding.",
      "Call out unreadable, cropped, blurred, or uncertain areas explicitly.",
      "Do not invent text that is not visible."
    ].join(" "),
    notes: "Executed by a vision-capable provider such as OpenAI-compatible vision or Ollama multimodal."
  },
  {
    id: "file_processing",
    title: "File Processing",
    scope: "file",
    mode: "file_processing",
    notes: "Not yet connected to a file understanding prompt."
  },
  {
    id: "web_edit",
    title: "Web Edit",
    scope: "web",
    mode: "web_edit",
    notes: "Represents a human review state instead of a local AI prompt."
  }
];

const promptProfiles: PromptProfile[] = [
  {
    id: "reading",
    displayName: "Reading",
    answerStyle: "standard",
    outputFormat: "bullets",
    tone: "neutral",
    focus: ["topic", "key_points", "read_next"],
    maxOutputLength: "medium",
    notes: "Balanced summary for general reading groups."
  },
  {
    id: "research",
    displayName: "Research",
    answerStyle: "detailed",
    outputFormat: "bullets",
    tone: "formal",
    focus: ["evidence", "uncertainty", "risks"],
    maxOutputLength: "long",
    notes: "More analytical and more cautious on evidence boundaries."
  },
  {
    id: "sector-research",
    displayName: "Sector Research",
    answerStyle: "detailed",
    outputFormat: "bullets",
    tone: "formal",
    focus: [
      "demand_drivers",
      "constraints",
      "technology_routes",
      "policy_and_regulation",
      "industry_chain",
      "key_entities",
      "research_implications"
    ],
    maxOutputLength: "long",
    notes: "Optimized for AI/AI supply chain, energy and rare earths, biotech, and other sector-level thematic research."
  },
  {
    id: "equity-research",
    displayName: "Equity Research",
    answerStyle: "detailed",
    outputFormat: "bullets",
    tone: "formal",
    focus: [
      "demand_drivers",
      "constraints",
      "technology_routes",
      "vendor_choices",
      "industry_chain",
      "equity_implications"
    ],
    maxOutputLength: "long",
    notes: "Optimized for industry-chain, stock, and investment-thesis research."
  },
  {
    id: "management",
    displayName: "Management",
    answerStyle: "brief",
    outputFormat: "decision",
    tone: "executive",
    focus: ["conclusion", "impact", "next_actions"],
    maxOutputLength: "short",
    notes: "Short decision-oriented output for managers."
  },
  {
    id: "image-lab",
    displayName: "Image Lab",
    answerStyle: "standard",
    outputFormat: "bullets",
    tone: "neutral",
    focus: ["ocr_text", "visual_structure", "uncertainty"],
    maxOutputLength: "medium",
    notes: "Optimized for OCR, screenshots, and image-driven research."
  }
];

const promptProfileMap = new Map(promptProfiles.map((item) => [item.id, item] as const));

const promptProfileModeOverrides: Record<string, Partial<Record<TaskMode, PromptProfileModeOverride>>> = {
  reading: {
    article_precheck: {
      answerStyle: "standard",
      outputFormat: "bullets",
      focus: ["topic", "key_points", "worth_reading", "next_step"],
      maxOutputLength: "medium"
    },
    article_research: {
      answerStyle: "detailed",
      outputFormat: "bullets",
      focus: ["core_argument", "key_clues", "follow_up_reading"],
      maxOutputLength: "long"
    },
    article_verify: {
      answerStyle: "standard",
      outputFormat: "bullets",
      focus: ["supported_points", "uncertain_points"],
      maxOutputLength: "medium"
    },
    summarize: {
      answerStyle: "brief",
      outputFormat: "paragraphs",
      focus: ["summary", "key_points"],
      maxOutputLength: "short"
    }
  },
  research: {
    article_precheck: {
      answerStyle: "detailed",
      outputFormat: "bullets",
      tone: "formal",
      focus: ["evidence", "uncertainty", "research_value"],
      maxOutputLength: "long"
    },
    article_research: {
      answerStyle: "detailed",
      outputFormat: "bullets",
      tone: "formal",
      focus: ["key_clues", "extended_research", "follow_up_questions", "knowledge_value"],
      maxOutputLength: "long"
    },
    article_verify: {
      answerStyle: "detailed",
      outputFormat: "bullets",
      tone: "formal",
      focus: ["supported_claims", "weak_evidence", "verification_targets"],
      maxOutputLength: "long"
    },
    summarize: {
      answerStyle: "standard",
      outputFormat: "bullets",
      tone: "formal",
      focus: ["topic", "main_points", "uncertainty"],
      maxOutputLength: "medium"
    }
  },
  "sector-research": {
    article_precheck: {
      answerStyle: "detailed",
      outputFormat: "bullets",
      tone: "formal",
      focus: [
        "theme",
        "core_driver",
        "constraint",
        "technology_route",
        "policy_signal",
        "research_value"
      ],
      maxOutputLength: "long"
    },
    article_research: {
      answerStyle: "detailed",
      outputFormat: "bullets",
      tone: "formal",
      focus: [
        "forward_demand_chain",
        "reverse_constraints",
        "substitution_risks",
        "technology_routes",
        "vendor_or_lab_choices",
        "policy_and_regulation",
        "industry_chain_mapping",
        "cross_border_implications",
        "research_implications"
      ],
      maxOutputLength: "long"
    },
    article_verify: {
      answerStyle: "detailed",
      outputFormat: "bullets",
      tone: "formal",
      focus: [
        "supported_claims",
        "weak_evidence",
        "technical_constraints",
        "policy_or_regulatory_claims",
        "verification_targets"
      ],
      maxOutputLength: "long"
    },
    summarize: {
      answerStyle: "standard",
      outputFormat: "bullets",
      tone: "formal",
      focus: [
        "theme",
        "industry_chain",
        "key_drivers",
        "constraints",
        "policy_signal",
        "research_relevance"
      ],
      maxOutputLength: "medium"
    },
    general_chat: {
      answerStyle: "standard",
      outputFormat: "bullets",
      tone: "formal",
      focus: [
        "direct_answer",
        "causal_chain",
        "constraints",
        "route_choice",
        "next_research_step"
      ],
      maxOutputLength: "medium"
    }
  },
  "equity-research": {
    article_precheck: {
      answerStyle: "detailed",
      outputFormat: "bullets",
      tone: "formal",
      focus: [
        "theme",
        "demand_driver",
        "constraint",
        "route_choice",
        "research_value"
      ],
      maxOutputLength: "long"
    },
    article_research: {
      answerStyle: "detailed",
      outputFormat: "bullets",
      tone: "formal",
      focus: [
        "forward_demand_chain",
        "reverse_constraints",
        "substitution_risks",
        "technology_routes",
        "vendor_roadmaps",
        "company_mapping",
        "equity_implications"
      ],
      maxOutputLength: "long"
    },
    article_verify: {
      answerStyle: "detailed",
      outputFormat: "bullets",
      tone: "formal",
      focus: [
        "supported_claims",
        "weak_evidence",
        "vendor_statements",
        "technical_constraints",
        "verification_targets"
      ],
      maxOutputLength: "long"
    },
    summarize: {
      answerStyle: "standard",
      outputFormat: "bullets",
      tone: "formal",
      focus: [
        "theme",
        "industry_chain",
        "key_drivers",
        "constraints",
        "equity_relevance"
      ],
      maxOutputLength: "medium"
    },
    general_chat: {
      answerStyle: "standard",
      outputFormat: "bullets",
      tone: "formal",
      focus: [
        "direct_answer",
        "causal_chain",
        "constraints",
        "next_research_step"
      ],
      maxOutputLength: "medium"
    }
  },
  management: {
    article_precheck: {
      answerStyle: "brief",
      outputFormat: "decision",
      tone: "executive",
      focus: ["conclusion", "worth_reading", "next_actions"],
      maxOutputLength: "short"
    },
    article_research: {
      answerStyle: "standard",
      outputFormat: "decision",
      tone: "executive",
      focus: ["decision_relevance", "key_clues", "recommended_follow_up"],
      maxOutputLength: "medium"
    },
    article_verify: {
      answerStyle: "brief",
      outputFormat: "decision",
      tone: "executive",
      focus: ["confirmed_points", "key_risks", "required_checks"],
      maxOutputLength: "short"
    },
    summarize: {
      answerStyle: "brief",
      outputFormat: "decision",
      tone: "executive",
      focus: ["conclusion", "impact", "next_actions"],
      maxOutputLength: "short"
    },
    general_chat: {
      answerStyle: "brief",
      outputFormat: "paragraphs",
      tone: "executive",
      focus: ["direct_answer", "actionable_next_step"],
      maxOutputLength: "short"
    }
  },
  "image-lab": {
    article_precheck: {
      answerStyle: "standard",
      outputFormat: "bullets",
      focus: ["image_text", "visual_findings", "uncertainty"],
      maxOutputLength: "medium"
    },
    article_research: {
      answerStyle: "detailed",
      outputFormat: "bullets",
      focus: ["image_text", "visual_clues", "extended_research", "uncertainty"],
      maxOutputLength: "long"
    },
    article_verify: {
      answerStyle: "standard",
      outputFormat: "bullets",
      focus: ["ocr_supported_points", "visual_ambiguity", "verification_targets"],
      maxOutputLength: "medium"
    },
    summarize: {
      answerStyle: "standard",
      outputFormat: "bullets",
      focus: ["ocr_text", "visual_summary", "uncertainty"],
      maxOutputLength: "medium"
    },
    general_chat: {
      answerStyle: "standard",
      outputFormat: "bullets",
      focus: ["image_content", "ocr_text", "uncertainty"],
      maxOutputLength: "medium"
    }
  }
};

export function getSystemPromptForMode(mode: TaskMode) {
  return researchPromptMap[mode]?.systemPrompt;
}

export function listPromptSpecs(): PromptSpec[] {
  const researchSpecs = Object.values(researchPromptMap).filter(
    (item): item is PromptSpec => Boolean(item)
  );
  return [...researchSpecs, ...nonLocalPromptSpecs];
}

export function listPromptProfiles() {
  return promptProfiles;
}

export function getPromptProfile(profileId?: string) {
  return profileId ? promptProfileMap.get(profileId) : undefined;
}

export function isPromptProfileId(value: unknown): value is string {
  return typeof value === "string" && promptProfileMap.has(value);
}

export function buildWorkspacePreference(profileId: string | undefined, mode?: TaskMode) {
  const profile = getPromptProfile(profileId);
  if (!profile) {
    return undefined;
  }

  const modeOverride = mode && profileId ? promptProfileModeOverrides[profileId]?.[mode] : undefined;
  const resolved = mergePromptProfile(profile, modeOverride);

  const lines = [
    "Workspace preference:",
    `- profile: ${profile.id}`,
    ...(mode ? [`- mode: ${mode}`] : []),
    ...(resolved.answerStyle ? [`- answer style: ${resolved.answerStyle}`] : []),
    ...(resolved.outputFormat ? [`- output format: ${resolved.outputFormat}`] : []),
    ...(resolved.tone ? [`- tone: ${resolved.tone}`] : []),
    ...(resolved.focus?.length ? [`- focus: ${resolved.focus.join(", ")}`] : []),
    ...(resolved.maxOutputLength ? [`- max output length: ${resolved.maxOutputLength}`] : [])
  ];

  return lines.join("\n");
}

function mergePromptProfile(profile: PromptProfile, override?: PromptProfileModeOverride) {
  if (!override) {
    return profile;
  }

  return {
    ...profile,
    ...override,
    ...(override.focus ? { focus: override.focus } : {}),
    ...(override.preferredSections ? { preferredSections: override.preferredSections } : {})
  };
}
