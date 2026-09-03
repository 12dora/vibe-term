import { type ClassValue, clsx } from 'clsx';
import { mergeClassNames } from './class-merge';

export function cn(...inputs: ClassValue[]) {
  return mergeClassNames(clsx(inputs));
}
