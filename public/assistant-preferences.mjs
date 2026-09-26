import { taskLabels } from './exam-labels.mjs';

export const preferenceOptions = Object.freeze({
  explanationLanguage: Object.freeze({zh:'中文',en:'英文',bilingual:'双语'}),
  feedbackStyle: Object.freeze({brief:'简要',detailed:'详细'}),
  practiceGoal: Object.freeze({reading:'阅读',listening:'听力',speaking:'口语',writing:'写作',...taskLabels}),
});
export const preferenceLabels = Object.freeze({explanationLanguage:'解释语言',feedbackStyle:'反馈详略',practiceGoal:'练习目标'});
export const validPreference = (key,value) => typeof key==='string' && typeof value==='string' && Object.hasOwn(preferenceOptions,key) && Object.hasOwn(preferenceOptions[key],value);
export const describePreference = ({key,value}) => validPreference(key,value) ? `${preferenceLabels[key]}：${preferenceOptions[key][value]}` : '';
