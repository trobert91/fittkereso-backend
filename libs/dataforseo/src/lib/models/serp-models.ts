import { BaseDataForSeoResponse } from './base-dataforseo-response';

export interface GoogleSerpResponse extends BaseDataForSeoResponse {
  tasks: GoogleSerpTask[];
}

export interface GoogleSerpTask {
  id: string;
  status_code: number;
  status_message: string;
  time: string;
  cost: number;
  result_count: number;
  path: string[];
  data: GoogleSerpTaskData;
  result: DataforSeoGoogleSerpResult[];
}

export interface GoogleSerpTaskData {
  api: string;
  function: string;
  se: string;
  se_type: string;
  language_code: string;
  location_code: number;
  keyword: string;
  device: string;
  group_organic_results: boolean;
  os: string;
}

export interface DataforSeoGoogleSerpResult {
  keyword: string;
  type: string;
  se_domain: string;
  location_code: number;
  language_code: string;
  check_url: string;
  datetime: string;
  spell: string | null;
  refinement_chips: string[] | null;
  item_types: string[];
  se_results_count: number;
  items_count: number;
  items: GoogleSerpItem[];
}

export interface GoogleSerpItem {
  type: string;
  rank_group: number;
  rank_absolute: number;
  position: string;
  xpath: string;
  domain: string;
  title: string;
  url: string;
  cache_url: string | null;
  related_search_url: string | null;
  breadcrumb: string;
  website_name: string;
  is_image: boolean;
  is_video: boolean;
  is_featured_snippet: boolean;
  is_malicious: boolean;
  is_web_story: boolean;
  description: string;
  pre_snippet: string | null;
  extended_snippet: string | null;
  images: string[] | null;
  amp_version: boolean;
  rating: number | null;
  price: string | null;
  highlighted: string[];
  links: GoogleSerpItemLink[];
  faq: any | null;
  extended_people_also_search: any | null;
  about_this_result: any | null;
  related_result: any | null;
  timestamp: string | null;
  rectangle: any | null;
}

export interface GoogleSerpItemLink {
  type: string;
  title: string;
  description: string;
  url: string;
  domain: string;
}
