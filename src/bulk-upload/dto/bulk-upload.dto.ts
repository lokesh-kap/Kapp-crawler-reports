import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class BulkUploadRowDto {
  @IsOptional()
  @IsString()
  login_url?: string;

  @IsString()
  @MinLength(1)
  login_id: string;

  @IsString()
  @MinLength(1)
  password: string;

  @IsString()
  @MinLength(1)
  client_name: string;

  @IsOptional()
  @IsString()
  client_source?: string;

  /** Start date for range steps (e.g. YYYY-MM-DD). */
  @IsString()
  @MinLength(1)
  date_from: string;

  /** End date; defaults to today (server) when omitted. */
  @IsOptional()
  @IsString()
  date_to?: string;

  @IsString()
  @MinLength(1)
  lead_url: string;

  @IsString()
  @MinLength(1)
  medium_url: string;

  @IsInt()
  client_id: number;

  @IsInt()
  year: number;
}

export class BulkUploadRequestDto {
  @IsInt()
  config_id: number;

  @IsInt()
  user_id: number;

  /** Each element validated per row in `BulkUploadService` so one bad row does not fail the batch. */
  @IsArray()
  @ArrayMinSize(1)
  rows: Record<string, unknown>[];
}
