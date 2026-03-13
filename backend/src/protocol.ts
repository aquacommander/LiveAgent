export type ClientToServerMessage =
  | {
      type: 'start_session';
      payload?: {
        model?: string;
        voiceName?: string;
        responseModalities?: string[];
      };
    }
  | {
      type: 'input_audio';
      payload: {
        data: string;
        mimeType: string;
      };
    }
  | {
      type: 'input_image';
      payload: {
        data: string;
        mimeType: string;
      };
    }
  | {
      type: 'input_text';
      payload: {
        text: string;
      };
    }
  | {
      type: 'end_session';
    };

export type AgentMode = 'conversation' | 'creative_storyteller';

export type RequirementProfile = {
  objective: string;
  audience: string;
  tone: string;
  style: string;
  constraints: string[];
  missingInformation: string[];
  confidence: number;
};

export type StoryPartKind =
  | 'narration'
  | 'image_prompt'
  | 'voiceover'
  | 'storyboard'
  | 'hashtags';

export type StoryPart = {
  sequence: number;
  sceneId: string;
  kind: StoryPartKind;
  content: string;
};

export type ServerToClientMessage =
  | {
      type: 'status';
      payload: {
        message: string;
      };
    }
  | {
      type: 'session_ready';
      payload: {
        message: string;
      };
    }
  | {
      type: 'error';
      payload: {
        message: string;
      };
    }
  | {
      type: 'model_audio';
      payload: {
        data: string;
        mimeType: string;
      };
    }
  | {
      type: 'model_text';
      payload: {
        text: string;
      };
    }
  | {
      type: 'interrupted';
    }
  | {
      type: 'mode_changed';
      payload: {
        mode: AgentMode;
        reason: string;
      };
    }
  | {
      type: 'requirement_profile_updated';
      payload: {
        profile: RequirementProfile;
      };
    }
  | {
      type: 'clarification_question';
      payload: {
        question: string;
      };
    }
  | {
      type: 'story_part';
      payload: StoryPart;
    }
  | {
      type: 'story_generation_done';
      payload: {
        summary: string;
      };
    };
