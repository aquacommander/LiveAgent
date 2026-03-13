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
    };
