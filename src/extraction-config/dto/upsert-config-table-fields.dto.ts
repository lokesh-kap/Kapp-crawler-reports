import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

class UpsertConfigTableFieldItemDto {
  @IsString()
  field_key: string;

  @IsString()
  db_column: string;

  @IsString()
  selector: string;

  @IsOptional()
  @IsString()
  @IsIn(['text', 'attr'])
  data_type?: 'text' | 'attr';

  @IsOptional()
  @IsString()
  attribute?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sequence?: number;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class UpsertConfigTableFieldsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => UpsertConfigTableFieldItemDto)
  fields: UpsertConfigTableFieldItemDto[];
}

