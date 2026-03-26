import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class ScrapeTargetDto {
  // Preferred: PK of `client_wise` table
  @IsOptional()
  @IsInt()
  @Min(1)
  client_wise_id?: number;

  // Backward compatible identifiers (used if client_wise_id is not provided)
  @IsOptional()
  @IsInt()
  @Min(1)
  client_id?: number;

  @IsOptional()
  @IsInt()
  @Min(2000)
  year?: number;

  // Provider config_id (the one picked in UI dropdown)
  @IsOptional()
  @IsInt()
  @Min(1)
  config_id?: number;

  // Optional overrides; by default backend uses env configuration
  @IsOptional()
  @IsBoolean()
  use_proxy?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  max_retries?: number;

  // Optional overrides (normally computed/derived from saved config and heuristics)
  @IsOptional()
  @IsString()
  item_xpath?: string;

  @IsOptional()
  @IsString()
  next_button_xpath?: string;

  @IsOptional()
  @IsString()
  advanced_filters_toggle_xpath?: string;

  // Pagination tuning
  @IsOptional()
  @IsInt()
  @Min(1)
  max_pages?: number;

  @IsOptional()
  @IsInt()
  delay_ms_between_pages?: number;

  @IsOptional()
  @IsBoolean()
  stop_when_next_disabled?: boolean;

  @IsOptional()
  @IsString()
  disabled_attribute?: string;
}

