import { config } from '../../config';

export const featureFlagNames = [
  'AI_SEARCH',
  'STYLE_ASSISTANT',
  'COMPLETE_THE_LOOK',
  'RECOMMENDATIONS',
  'PERSONALIZED_RECOMMENDATIONS',
  'RECENTLY_VIEWED',
  'AI_PRODUCT_FILL',
  'PARSER_1688',
  'PARSER_PINDUODUO',
  'IPOST',
  'N8N',
  'TELEGRAM_PRODUCT_PUBLISH',
  'AUTO_CURRENCY',
  'SMS_VERIFICATION',
  'VISUAL_SEARCH',
  'SIMILAR_PRODUCTS',
  'IMAGE_EMBEDDINGS',
  'FITTING_ROOM',
  'LOCAL_3D_GENERATION',
] as const;

export type FeatureFlag = typeof featureFlagNames[number];

type FeatureFlagValues = Record<FeatureFlag, boolean>;

export function createFeatureFlags(values: FeatureFlagValues) {
  return {
    isEnabled(flag: FeatureFlag): boolean {
      return values[flag];
    },
    capabilities() {
      return {
        aiSearch: values.AI_SEARCH,
        styleAssistant: values.STYLE_ASSISTANT,
        completeTheLook: values.COMPLETE_THE_LOOK,
        recommendations: values.RECOMMENDATIONS,
        personalizedRecommendations: values.PERSONALIZED_RECOMMENDATIONS,
        recentlyViewed: values.RECENTLY_VIEWED,
        aiProductFill: values.AI_PRODUCT_FILL,
        parser1688: values.PARSER_1688,
        parserPinduoduo: values.PARSER_PINDUODUO,
        ipost: values.IPOST,
        n8n: values.N8N,
        telegramProductPublish: values.TELEGRAM_PRODUCT_PUBLISH,
        autoCurrency: values.AUTO_CURRENCY,
        smsVerification: values.SMS_VERIFICATION,
        visualSearch: values.VISUAL_SEARCH,
        similarProducts: values.SIMILAR_PRODUCTS,
        imageEmbeddings: values.IMAGE_EMBEDDINGS,
        fittingRoom: values.FITTING_ROOM,
        local3dGeneration: values.LOCAL_3D_GENERATION,
      };
    },
  };
}

export const featureFlags = createFeatureFlags({
  AI_SEARCH: config.FEATURE_AI_SEARCH,
  STYLE_ASSISTANT: config.FEATURE_STYLE_ASSISTANT,
  COMPLETE_THE_LOOK: config.FEATURE_COMPLETE_THE_LOOK,
  RECOMMENDATIONS: config.FEATURE_RECOMMENDATIONS,
  PERSONALIZED_RECOMMENDATIONS: config.FEATURE_PERSONALIZED_RECOMMENDATIONS,
  RECENTLY_VIEWED: config.FEATURE_RECENTLY_VIEWED,
  AI_PRODUCT_FILL: config.FEATURE_AI_PRODUCT_FILL,
  PARSER_1688: config.FEATURE_1688_PARSER,
  PARSER_PINDUODUO: config.FEATURE_PINDUODUO_PARSER,
  IPOST: false,
  N8N: config.FEATURE_N8N && Boolean(config.N8N_WEBHOOK_URL && config.N8N_WEBHOOK_SECRET),
  TELEGRAM_PRODUCT_PUBLISH: config.FEATURE_TELEGRAM_PRODUCT_PUBLISH,
  AUTO_CURRENCY: config.FEATURE_AUTO_CURRENCY,
  SMS_VERIFICATION: config.FEATURE_SMS_VERIFICATION,
  VISUAL_SEARCH: config.FEATURE_VISUAL_SEARCH,
  SIMILAR_PRODUCTS: config.FEATURE_SIMILAR_PRODUCTS,
  IMAGE_EMBEDDINGS: config.FEATURE_IMAGE_EMBEDDINGS,
  FITTING_ROOM: config.FITTING_ROOM_ENABLED,
  LOCAL_3D_GENERATION: config.LOCAL_3D_GENERATION_ENABLED,
});
